import 'dotenv/config';
import './logger.js'; // Must be imported early to intercept console logs
// Server initialization with OpenCLI and DEV auth
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, withTenantTransaction, isTransientDbError, withDbRetry } from './db/client.js';
import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm';
import { icpDefinitions, importBatches, prospects, engagementPosts, engagementControls, browserAccounts, auditEvents, scheduledActions, reviewDecisions, icpEvaluations, manualTasks, executionEvidence, engagementHistory, campaignEnrollments, campaigns } from './db/schema.js';
import { IcpCriteriaSchema } from './schemas/icp.js';
import { importProspectsFromCsv } from './services/icp/csv-importer.js';
import { icpPipeline } from './services/icp/index.js';
import { tenantContext } from './db/tenant-context.js';
import { stringify } from 'csv-stringify/sync';
import { EngagementService } from './services/engagement/engagement-service.js';
import type { EngagementAIProvider } from './services/engagement/engagement-ai-provider.js';

import { LunaEngagementProvider } from './services/engagement/luna-engagement-provider.js';
import { ProfileActivityPostSource } from './services/engagement/profile-activity-post-source.js';
import { requireRequestContext, requestContextMiddleware, structuredRefusal } from './server/request-context.js';
import { DrizzleAdapter } from './db/drizzle-adapter.js';
import { LeaseService } from './services/lease-service.js';
import { BudgetService } from './services/budget-service.js';
import { ActionQueueService } from './services/action-queue-service.js';
import { FakeExecutor } from './executors/fake.js';
import { ManualExecutor } from './executors/manual.js';
import { OpenCliExecutor } from './executors/opencli.js';
import { PlaywrightExecutor } from './executors/playwright.js';
import { SafetyGate } from './services/safety-gate.js';
import { isWithinWorkingHours } from './services/safety-resolver.js';
import { recommendationRevisions, recommendationApprovals, engagementDrafts, dailyActionBudgets } from './db/schema.js';
import { ProspectDiscoveryService, discoveryDedupeKey } from './services/discovery/prospect-discovery-service.js';
import { GoogleXraySource, XrayBlockedError, XrayNetworkError, XrayRateLimitedError } from './services/discovery/google-xray-source.js';
import { OpenCliLinkedinSource, OpenCliUnavailableError, OpenCliExecutionError } from './services/discovery/opencli-linkedin-source.js';
import { DEFAULT_XRAY_NICHES, DEFAULT_XRAY_TITLES } from './services/discovery/xray-query-builder.js';
import { ContentSearchChannel } from './services/discovery/content-search-channel.js';
import { BuyingSignalClassifier, FakeBuyingSignalProvider } from './services/discovery/buying-signal-classifier.js';
import { LunaBuyingSignalProvider } from './services/discovery/luna-buying-signal-provider.js';
import { OpenCliContentSearchRunner } from './services/discovery/opencli-content-search-runner.js';
import { OpenCliPostEngagerRunner, type PostRecency } from './services/discovery/opencli-post-engager-runner.js';
import { EngagerTargetRegistry } from './services/discovery/engager-target-registry.js';
import { PostEngagerChannel } from './services/discovery/post-engager-channel.js';
import { promoteProspect } from './services/discovery/promotion-service.js';

const app = express();
const port = Number(process.env.PORT ?? 3000);
const singleUserTenantId = process.env.SINGLE_USER_TENANT_ID ?? '00000000-0000-0000-0000-000000000001';

app.use(express.json({ limit: '5mb' }));
app.use(express.text({ type: 'text/csv', limit: '5mb' }));
app.use('/api', requestContextMiddleware);

function tenantOf(request: express.Request): string {
  return requireRequestContext(request).tenantId;
}

function operatorOf(request: express.Request): string {
  return requireRequestContext(request).operatorId;
}

function correlationOf(request: express.Request): string {
  return requireRequestContext(request).correlationId;
}

function withRequestTenant<T>(request: express.Request, callback: () => Promise<T>): Promise<T> {
  return tenantContext.run({ tenantId: tenantOf(request) }, callback);
}

function parseCriteria(input: unknown) {
  return IcpCriteriaSchema.parse(input ?? {});
}

function errorResponse(error: unknown) {
  return error instanceof Error ? error.message : 'Unexpected server error';
}

function handleDbError(
  err: unknown,
  res: express.Response,
  req: express.Request,
  fallbackCode = 'POST_NOT_ELIGIBLE',
  fallbackStatus = 500,
) {
  if (isTransientDbError(err)) {
    return res
      .set('Retry-After', '5')
      .status(503)
      .json(structuredRefusal('DB_UNAVAILABLE', errorResponse(err), correlationOf(req)));
  }
  return res
    .status(fallbackStatus)
    .json(structuredRefusal(fallbackCode, errorResponse(err), correlationOf(req)));
}


// ─── Build EngagementService ──────────────────────────────────────────────────
// Use Luna if CODEX_EVERYWHERE_API_KEY is set, else fall back to fake provider.
// Browser discovery is Feature 0.5-only and remains fixture-first by default.

function buildEngagementService(): EngagementService {
  const aiProvider: EngagementAIProvider = process.env.GEMINI_API_KEY || process.env.CODEX_EVERYWHERE_API_KEY
    ? new LunaEngagementProvider()
    : {
      providerName: 'fake',
      async generateComment(input) {
        return {
          commentText: `The point about ${input.postText.split(/[.!?]/)[0]?.slice(0, 80) ?? 'this challenge'} is especially relevant.`,
          groundingEvidence: input.postText.split(/[.!?]/)[0]?.trim() ?? input.postText.slice(0, 80),
          providerMeta: { provider: 'fake' },
        };
      },
    };
  const postSource = new ProfileActivityPostSource();

  return new EngagementService({
    postSource,
    aiProvider,
    filterOptions: { maxAgeDays: 7, minTextLength: 50 },
    cooldownConfig: { commentCooldownDays: 14, likeCooldownDays: 5, dailyCommentCap: 5, dailyLikeCap: 10 },
  });
}

const engagementService = buildEngagementService();

function buildQueueForMode(mode: string): ActionQueueService {
  const adapter = new DrizzleAdapter(db as never);
  const leaseService = new LeaseService(adapter);
  const modeUpper = String(mode ?? 'SIMULATE').toUpperCase();
  let executor;
  if (modeUpper === 'MANUAL') {
    executor = new ManualExecutor();
  } else if (modeUpper === 'BROWSER') {
    if (process.env.FEATURE_05_BROWSER_ENABLED !== '1') {
      throw new Error('FEATURE_05_BROWSER_DISABLED');
    }
    executor = new OpenCliExecutor();
  } else {
    executor = new FakeExecutor();
  }
  return new ActionQueueService({
    db: adapter,
    leaseService,
    budgetService: new BudgetService(adapter),
    executor,
    safetyGate: new SafetyGate(),
    resolveSafety: async (action, tenantId) => {
      const revisionId = (action as { revisionId?: string }).revisionId;
      const postHash = (action as { postHash?: string }).postHash;
      const actionType = String(action.actionType).toUpperCase() as 'LIKE' | 'COMMENT';
      return withRequestTenantUnsafe(tenantId, async () => {
        const revision = revisionId
          ? await withDbRetry(() => db.query.recommendationRevisions.findFirst({ where: eq(recommendationRevisions.id, revisionId) }))
          : undefined;
        const approval = revision
          ? await withDbRetry(() => db.query.recommendationApprovals.findFirst({ where: eq(recommendationApprovals.revisionId, revision.id) }))
          : undefined;
        const approvalCurrent = !!revision && revision.state === 'APPROVED' && approval?.state === 'APPROVED' && (!approval.expiresAt || approval.expiresAt > new Date()) && revision.postHash === postHash;
        const control = await withDbRetry(() => db.query.engagementControls.findFirst({ where: and(eq(engagementControls.tenantId, tenantId), eq(engagementControls.accountId, action.accountId), eq(engagementControls.actionType, actionType)) }));
        const account = await withDbRetry(() => db.query.browserAccounts.findFirst({ where: and(eq(browserAccounts.tenantId, tenantId), eq(browserAccounts.id, action.accountId)) }));
        // Persistence-backed prospect readiness: the tenant-owned prospect behind
        // the claimed action must be campaign-ready (schema: currentStage).
        const prospect = await withDbRetry(() => db.query.prospects.findFirst({ where: and(eq(prospects.tenantId, tenantId), eq(prospects.id, action.prospectId)) }));
        const prospectReady = prospect?.currentStage === 'READY_FOR_CAMPAIGN';
        // Persistence-backed post eligibility: the tenant-owned post matching the
        // claimed action's hash must exist. Where the row carries an explicit
        // eligibility decision it must be ELIGIBLE (fail closed otherwise).
        const post = postHash
          ? await withDbRetry(() => db.query.engagementPosts.findFirst({ where: and(eq(engagementPosts.tenantId, tenantId), eq(engagementPosts.contentHash, postHash)) }))
          : undefined;
        const eligibilityDecision = (post as unknown as { eligibilityDecision?: string } | undefined)?.eligibilityDecision;
        const postEligible = !!post && (eligibilityDecision === undefined || eligibilityDecision === 'ELIGIBLE');
        // Persistence-backed lease validity via the lease service (fail closed).
        const activeLease = await leaseService.getActiveLease(tenantId, action.accountId).catch(() => undefined);
        const leaseValid = !!activeLease && activeLease.expiresAt > new Date();
        // Action-specific daily budget for the claimed action's type (fail closed
        // when no budget row exists for this tenant/account/action/day).
        const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
        const budgets = await withDbRetry(() => db.query.dailyActionBudgets.findMany({ where: and(eq(dailyActionBudgets.tenantId, tenantId), eq(dailyActionBudgets.accountId, action.accountId)) }));
        const budget = budgets.find((row) => String(row.actionType).toUpperCase() === actionType && row.budgetDate >= dayStart && row.budgetDate < dayEnd)
          ?? budgets.find((row) => String(row.actionType).toUpperCase() === actionType);
        const budgetAvailable = budget ? budget.reservedCount + budget.completedCount < budget.limit : false;
        const modeUpper = (String((action as { mode?: string }).mode ?? mode).toUpperCase()) as 'SIMULATE' | 'MANUAL' | 'BROWSER';
        return {
          tenantId,
          prospectReady,
          postEligible,
          approvalCurrent,
          actionType,
          mode: modeUpper,
          revisionId,
          postHash,
          policy: {
            likeEnabled: actionType === 'LIKE' ? !!control?.enabled : true,
            commentEnabled: actionType === 'COMMENT' ? !!control?.enabled : true,
            feature05BrowserEnabled: process.env.FEATURE_05_BROWSER_ENABLED === '1',
            pilotActionsRemaining: 5,
            killSwitchActive: !!control?.killSwitchActive,
            accountPaused: account ? account.health !== 'HEALTHY' : false,
            sessionHealthy: account ? !!account.sessionExpiresAt && account.sessionExpiresAt > new Date() : true,
            cooldownActive: !!control?.cooldownUntil && control.cooldownUntil > new Date(),
            budgetAvailable,
            leaseValid,
            workingHours: process.env.DEV_AUTH_ENABLED === '1' || process.env.NODE_ENV !== 'production' || isWithinWorkingHours(new Date(), process.env.WORKING_HOURS_TZ ?? 'Asia/Kolkata'),
          },
        };
      });
    },
  });
}

function withRequestTenantUnsafe<T>(tenantId: string, callback: () => Promise<T>): Promise<T> {
  return tenantContext.run({ tenantId }, callback);
}

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (_request, response) => {
  response.json({ status: 'ok', mode: 'single-user' });
});

// ─── ICP routes ───────────────────────────────────────────────────────────────

app.post('/api/icps', async (request, response) => {
  try {
    const tenantId = tenantOf(request);
    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
    if (!name) return response.status(400).json(structuredRefusal('ICP_INVALID', 'ICP name is required', correlationOf(request)));
    const criteria = parseCriteria(request.body.criteria);
    const result = await withRequestTenant(request, () => db.insert(icpDefinitions).values({ tenantId, name, criteria }).returning());
    response.status(201).json(result[0]);
  } catch (error) {
    response.status(400).json(structuredRefusal('ICP_INVALID', errorResponse(error), correlationOf(request)));
  }
});

app.get('/api/icps', async (request, response) => {
  const tenantId = tenantOf(request);
  const results = await withRequestTenant(request, () => db.select().from(icpDefinitions).where(eq(icpDefinitions.tenantId, tenantId)).orderBy(desc(icpDefinitions.createdAt)));
  response.json(results);
});

// ─── Import routes ────────────────────────────────────────────────────────────

app.post('/api/imports', async (request, response) => {
  try {
    const tenantId = tenantOf(request);
    const csv = typeof request.body?.csv === 'string' ? request.body.csv : typeof request.body === 'string' ? request.body : '';
    const icpDefinitionId = typeof request.body?.icpDefinitionId === 'string' ? request.body.icpDefinitionId : '';
    const filename = typeof request.body?.filename === 'string' ? request.body.filename : 'prospects.csv';
    if (!csv || !icpDefinitionId) return response.status(400).json(structuredRefusal('ICP_INVALID', 'CSV and icpDefinitionId are required', correlationOf(request)));
    const rows = await importProspectsFromCsv(csv);
    const batch = await withRequestTenant(request, () => db.insert(importBatches).values({ tenantId, icpDefinitionId, filename, totalRows: rows.length, status: 'CREATED' }).returning());
    response.status(201).json({ batch: batch[0], rows: rows.length });
  } catch (error) {
    response.status(400).json(structuredRefusal('ICP_INVALID', errorResponse(error), correlationOf(request)));
  }
});

app.post('/api/imports/:id/process', async (request, response) => {
  try {
    const tenantId = tenantOf(request);
    const batch = await withRequestTenant(request, () => db.query.importBatches.findFirst({ where: and(eq(importBatches.id, request.params.id), eq(importBatches.tenantId, tenantId)) }));
    if (!batch) return response.status(404).json(structuredRefusal('ICP_INVALID', 'Import batch not found', correlationOf(request)));
    const csv = typeof request.body?.csv === 'string' ? request.body.csv : '';
    const rows = await importProspectsFromCsv(csv);
    await withRequestTenant(request, () => icpPipeline.run(tenantId, batch.icpDefinitionId!, rows, batch.filename));
    const updated = await withRequestTenant(request, () => db.query.importBatches.findFirst({ where: eq(importBatches.id, batch.id) }));
    response.json(updated);
  } catch (error) {
    response.status(400).json(structuredRefusal('ICP_INVALID', errorResponse(error), correlationOf(request)));
  }
});

// ─── Campaign routes ──────────────────────────────────────────────────────────

app.get('/api/campaigns', async (request, response) => {
  try {
    const tenantId = tenantOf(request);
    const rows = await withRequestTenant(request, () => db.select().from(campaigns).where(eq(campaigns.tenantId, tenantId)).orderBy(desc(campaigns.createdAt)));
    
    const enriched = await Promise.all(rows.map(async (c) => {
      const enrollments = await withRequestTenant(request, () => db.select().from(campaignEnrollments).where(eq(campaignEnrollments.campaignId, c.id)));
      return {
        ...c,
        enrolledCount: enrollments.length,
      };
    }));
    response.json(enriched);
  } catch (error) {
    response.status(500).json(structuredRefusal('TENANT_FORBIDDEN', errorResponse(error), correlationOf(request)));
  }
});

// ─── Prospect routes ──────────────────────────────────────────────────────────

app.get('/api/prospects', async (request, response) => {
  try {
    const tenantId = tenantOf(request);
    const campaignId = typeof request.query.campaignId === 'string' && request.query.campaignId.trim() ? request.query.campaignId.trim() : undefined;

    let results;
    if (campaignId) {
      const enrollments = await withRequestTenant(request, () => db.select({ prospectId: campaignEnrollments.prospectId }).from(campaignEnrollments).where(eq(campaignEnrollments.campaignId, campaignId)));
      const ids = enrollments.map(e => e.prospectId);
      if (ids.length === 0) return response.json([]);
      results = await withRequestTenant(request, () => db.select().from(prospects).where(and(eq(prospects.tenantId, tenantId), inArray(prospects.id, ids))).orderBy(desc(prospects.updatedAt)));
    } else {
      results = await withRequestTenant(request, () => db.select().from(prospects).where(eq(prospects.tenantId, tenantId)).orderBy(desc(prospects.updatedAt)));
    }
    response.json(results);
  } catch (error) {
    console.error('[API] /api/prospects failed:', error);
    response.status(500).json({ error: 'Database connection failed' });
  }
});

app.delete('/api/prospects/:id', async (request, response) => {
  try {
    const tenantId = tenantOf(request);
    const prospectId = request.params.id;
    const deleted = await withTenantTransaction(tenantId, async (transaction) => {
      const prospect = await transaction.query.prospects.findFirst({
        where: and(eq(prospects.id, prospectId), eq(prospects.tenantId, tenantId)),
      });
      if (!prospect) return false;

      const actions = await transaction.select({ id: scheduledActions.id }).from(scheduledActions)
        .where(and(eq(scheduledActions.prospectId, prospectId), eq(scheduledActions.tenantId, tenantId)));
      const actionIds = actions.map((action: { id: string }) => action.id);
      if (actionIds.length > 0) {
        await transaction.delete(executionEvidence).where(and(eq(executionEvidence.tenantId, tenantId), inArray(executionEvidence.scheduledActionId, actionIds)));
        await transaction.delete(manualTasks).where(and(eq(manualTasks.tenantId, tenantId), inArray(manualTasks.scheduledActionId, actionIds)));
      }

      const posts = await transaction.select({ id: engagementPosts.id }).from(engagementPosts)
        .where(and(eq(engagementPosts.prospectId, prospectId), eq(engagementPosts.tenantId, tenantId)));
      const postIds = posts.map((post: { id: string }) => post.id);
      const drafts = await transaction.select({ id: engagementDrafts.id }).from(engagementDrafts)
        .where(and(eq(engagementDrafts.prospectId, prospectId), eq(engagementDrafts.tenantId, tenantId)));
      const draftIds = drafts.map((draft: { id: string }) => draft.id);
      if (draftIds.length > 0) {
        const revisions = await transaction.select({ id: recommendationRevisions.id }).from(recommendationRevisions)
          .where(and(eq(recommendationRevisions.tenantId, tenantId), inArray(recommendationRevisions.draftId, draftIds)));
        const revisionIds = revisions.map((revision: { id: string }) => revision.id);
        if (revisionIds.length > 0) await transaction.delete(recommendationApprovals).where(and(eq(recommendationApprovals.tenantId, tenantId), inArray(recommendationApprovals.revisionId, revisionIds)));
        await transaction.delete(recommendationRevisions).where(and(eq(recommendationRevisions.tenantId, tenantId), inArray(recommendationRevisions.draftId, draftIds)));
      }
      if (postIds.length > 0) await transaction.delete(engagementHistory).where(and(eq(engagementHistory.tenantId, tenantId), inArray(engagementHistory.postId, postIds)));
      await transaction.delete(engagementDrafts).where(and(eq(engagementDrafts.tenantId, tenantId), eq(engagementDrafts.prospectId, prospectId)));
      if (postIds.length > 0) await transaction.delete(engagementPosts).where(and(eq(engagementPosts.tenantId, tenantId), inArray(engagementPosts.id, postIds)));
      await transaction.delete(reviewDecisions).where(and(eq(reviewDecisions.tenantId, tenantId), eq(reviewDecisions.prospectId, prospectId)));
      await transaction.delete(icpEvaluations).where(and(eq(icpEvaluations.tenantId, tenantId), eq(icpEvaluations.prospectId, prospectId)));
      await transaction.delete(campaignEnrollments).where(eq(campaignEnrollments.prospectId, prospectId));
      await transaction.delete(scheduledActions).where(and(eq(scheduledActions.tenantId, tenantId), eq(scheduledActions.prospectId, prospectId)));
      await transaction.delete(engagementHistory).where(and(eq(engagementHistory.tenantId, tenantId), eq(engagementHistory.prospectId, prospectId)));
      await transaction.delete(prospects).where(and(eq(prospects.id, prospectId), eq(prospects.tenantId, tenantId)));
      return true;
    });
    if (!deleted) return response.status(404).json(structuredRefusal('ICP_INVALID', 'Prospect not found', correlationOf(request)));
    response.json({ status: 'deleted', id: prospectId });
  } catch (error) {
    response.status(500).json({ status: 'failed', message: errorResponse(error), correlationId: correlationOf(request) });
  }
});

app.get('/api/prospects/discovery-state', async (request, response) => {
  try {
    const tenantId = tenantOf(request);
    const icp = await withRequestTenant(request, () => db.query.icpDefinitions.findFirst({
      where: eq(icpDefinitions.tenantId, tenantId),
      orderBy: [desc(icpDefinitions.updatedAt)],
    }));
    const criteria = (icp?.criteria ?? {}) as Record<string, unknown>;
    const lastPage = typeof criteria.lastDiscoveredPage === 'number' ? criteria.lastDiscoveredPage : 1;
    const nextPage = typeof criteria.lastNextPage === 'number' ? criteria.lastNextPage : lastPage + 1;
    const countries = Array.isArray(criteria.lastCountries) ? (criteria.lastCountries as string[]) : ['US'];
    const positions = Array.isArray(criteria.lastPositions) ? (criteria.lastPositions as string[]) : ['Director'];
    const keyword = typeof criteria.lastKeyword === 'string' ? criteria.lastKeyword : 'recruitment';

    response.json({
      page: lastPage,
      nextPage,
      countries,
      positions,
      keyword,
      icpDefinitionId: icp?.id ?? null,
    });
  } catch (error) {
    response.status(500).json(structuredRefusal('TENANT_FORBIDDEN', errorResponse(error), correlationOf(request)));
  }
});

// ─── Automated OpenCLI LinkedIn prospect discovery ──────────────────────────
// One-click discovery uses the authenticated OpenCLI LinkedIn browser session,
// dedupes by canonical LinkedIn URL, and ingests matches
// through the persistent ICP pipeline. Tenant/operator identity always comes
// from the trusted request context, never the request body.

app.post('/api/prospects/discover', async (request, response) => {
  try {
    const tenantId = tenantOf(request);
    const correlationId = correlationOf(request);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const locations = Array.isArray(body.locations)
      ? body.locations.filter((l): l is string => typeof l === 'string').map(l => l.trim()).filter(Boolean).slice(0, 5)
      : undefined;
    if (locations !== undefined && locations.some(l => l.length > 80)) {
      return response.status(400).json(structuredRefusal('ICP_INVALID', 'Each location must be 80 characters or fewer', correlationId));
    }

    const countries = Array.isArray(body.countries)
      ? body.countries.filter((c): c is string => typeof c === 'string').map(c => c.trim()).filter(Boolean)
      : undefined;
    const positions = Array.isArray(body.positions)
      ? body.positions.filter((p): p is string => typeof p === 'string').map(p => p.trim()).filter(Boolean)
      : undefined;
    const keyword = typeof body.keyword === 'string' && body.keyword.trim() ? body.keyword.trim() : undefined;
    const page = typeof body.page === 'number' && body.page > 0 ? body.page : 1;

    const maxResults = body.maxResults === undefined ? 10 : Number(body.maxResults);
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 25) {
      return response.status(400).json(structuredRefusal('ICP_INVALID', 'maxResults must be an integer between 1 and 25', correlationId));
    }

    // Resolve the target ICP: explicit id wins, then body criteria, then the
    // tenant's first saved ICP, then a created "Discovery ICP" default.
    let icpDefinitionId = typeof body.icpDefinitionId === 'string' ? body.icpDefinitionId : undefined;
    let criteria: Record<string, unknown> | undefined =
      body.criteria && typeof body.criteria === 'object' ? parseCriteria(body.criteria) as Record<string, unknown> : undefined;

    if (icpDefinitionId) {
      const icp = await withRequestTenant(request, () => db.query.icpDefinitions.findFirst({
        where: and(eq(icpDefinitions.id, icpDefinitionId as string), eq(icpDefinitions.tenantId, tenantId)),
      }));
      if (!icp) return response.status(404).json(structuredRefusal('ICP_NOT_FOUND', 'ICP definition not found', correlationId));
      criteria = (icp.criteria ?? {}) as Record<string, unknown>;
    } else {
      const existing = await withRequestTenant(request, () => db.select().from(icpDefinitions).where(eq(icpDefinitions.tenantId, tenantId)).orderBy(desc(icpDefinitions.createdAt)));
      if (existing[0]) {
        icpDefinitionId = existing[0].id;
        criteria = (existing[0].criteria ?? {}) as Record<string, unknown>;
      } else if (!criteria) {
        criteria = {
          titles: [...DEFAULT_XRAY_TITLES],
          industry: [...DEFAULT_XRAY_NICHES],
          geography: locations ?? [],
          qualificationThreshold: 80,
          reviewThreshold: 50,
        };
      }
      if (!icpDefinitionId) {
        const created = await withRequestTenant(request, () => db.insert(icpDefinitions).values({
          tenantId,
          name: 'Discovery ICP',
          criteria: criteria as Record<string, unknown>,
        }).returning());
        icpDefinitionId = created[0].id;
      }
    }

    const resolvedIcpId = icpDefinitionId as string;
    const openCliSource = new OpenCliLinkedinSource();
    const fallbackSource = new GoogleXraySource();

    const countriesLabel = (countries ?? ['US']).join(', ');
    const positionsLabel = (positions ?? ['Director']).join(', ');
    const campaignName = `Discovery — ${countriesLabel} | ${positionsLabel} | Page ${page}`;

    const createdCampaignRows = await withRequestTenant(request, () => db.insert(campaigns).values({
      tenantId,
      name: campaignName,
      roleId: resolvedIcpId,
      status: 'ACTIVE',
    }).returning());
    const createdCampaign = createdCampaignRows[0];

    const service = new ProspectDiscoveryService({
      searchCandidates: async (query) => {
        try {
          return await openCliSource.search(query, {
            countries,
            positions,
            keywords: keyword,
            page,
          });
        } catch (error) {
          if (!(error instanceof OpenCliUnavailableError) && !(error instanceof OpenCliExecutionError)) throw error;
          console.warn(`OpenCLI discovery failed (${(error as Error).message}), falling back to Google X-Ray`);
          return fallbackSource.search(query, { maxResults, timeoutMs: 10000 });
        }
      },
      findExisting: async (tId, normalizedUrls) => {
        if (normalizedUrls.length === 0) return new Set<string>();
        const rows = await withRequestTenant(request, () => db.select({ normalizedLinkedinUrl: prospects.normalizedLinkedinUrl })
          .from(prospects)
          .where(and(eq(prospects.tenantId, tId), inArray(prospects.normalizedLinkedinUrl, normalizedUrls))));
        return new Set(rows.map(r => String(r.normalizedLinkedinUrl).toLowerCase()));
      },
      ingest: async (tId, icpId, rows) => {
        await withRequestTenant(request, () => icpPipeline.run(tId, icpId, rows, `opencli-linkedin-discovery-p${page}.csv`));
        const normalizedUrls = rows.map((r) => discoveryDedupeKey(r.linkedinUrl)).filter((k): k is string => k !== null);
        if (normalizedUrls.length > 0 && createdCampaign) {
          const matchedProspects = await withRequestTenant(request, () => db.select().from(prospects).where(and(eq(prospects.tenantId, tId), inArray(prospects.normalizedLinkedinUrl, normalizedUrls))));
          for (const p of matchedProspects) {
            const currentAttrs = (p.customAttributes as Record<string, unknown>) ?? {};
            await withRequestTenant(request, () => db.update(prospects).set({
              currentStage: 'READY_FOR_CAMPAIGN',
              customAttributes: {
                ...currentAttrs,
                campaignId: createdCampaign.id,
                campaignName: createdCampaign.name,
                page,
              },
            }).where(eq(prospects.id, p.id)));

            await withRequestTenant(request, () => db.insert(campaignEnrollments).values({
              campaignId: createdCampaign.id,
              prospectId: p.id,
              currentStep: 0,
              status: 'ENROLLED',
            }).onConflictDoNothing());

            try {
              const scanRes = await withRequestTenant(request, () => engagementService.scanProspect(tId, p.id));
              if (scanRes.errors && scanRes.errors.length > 0) {
                console.warn(`[Ingest] Auto-scan for prospect ${p.id} had errors:`, scanRes.errors);
              }
            } catch (scanErr) {
              console.warn(`Auto-scan for prospect ${p.id} skipped or failed: ${(scanErr as Error).message}`);
            }
          }
        }
      },
      countStages: async (tId, normalizedUrls) => {
        if (normalizedUrls.length === 0) return { qualified: 0, reviewRequired: 0, disqualified: 0 };
        const rows = await withRequestTenant(request, () => db.select({ currentStage: prospects.currentStage, normalizedLinkedinUrl: prospects.normalizedLinkedinUrl })
          .from(prospects)
          .where(and(eq(prospects.tenantId, tId), inArray(prospects.normalizedLinkedinUrl, normalizedUrls))));
        let qualified = 0;
        let reviewRequired = 0;
        let disqualified = 0;
        for (const row of rows) {
          if (row.currentStage === 'EVALUATED' || row.currentStage === 'READY_FOR_CAMPAIGN' || row.currentStage === 'APPROVED_FOR_OUTREACH') qualified += 1;
          else if (row.currentStage === 'REQUIRES_REVIEW') reviewRequired += 1;
          else if (row.currentStage === 'REJECTED' || row.currentStage === 'FILTERED_OUT') disqualified += 1;
        }
        return { qualified, reviewRequired, disqualified };
      },
    });

    const report = await service.discover(tenantId, {
      icpDefinitionId: resolvedIcpId,
      criteria: criteria as never,
      locations,
      maxResults,
      locationDefault: locations?.[0],
    });

    // Persist latest discovery page state to DB (icpDefinitions.criteria & auditEvents)
    if (resolvedIcpId) {
      const updatedCriteria = {
        ...(criteria ?? {}),
        lastDiscoveredPage: page,
        lastNextPage: page + 1,
        lastCountries: countries ?? ['US'],
        lastPositions: positions ?? ['Director'],
        lastKeyword: keyword ?? 'recruitment',
        lastCampaignId: createdCampaign?.id,
        lastCampaignName: createdCampaign?.name,
      };
      await withRequestTenant(request, () => db.update(icpDefinitions).set({
        criteria: updatedCriteria,
        updatedAt: new Date(),
      }).where(and(eq(icpDefinitions.id, resolvedIcpId), eq(icpDefinitions.tenantId, tenantId))));
    }

    await withRequestTenant(request, () => new DrizzleAdapter(db as never).insertAuditEvent({
      tenantId,
      eventType: 'discovery.run.completed',
      entityType: 'icp_definition',
      entityId: resolvedIcpId,
      payload: {
        page,
        nextPage: page + 1,
        countries: countries ?? ['US'],
        positions: positions ?? ['Director'],
        keyword: keyword ?? 'recruitment',
        campaignId: createdCampaign?.id,
        campaignName: createdCampaign?.name,
        discovered: report.discovered,
        uniqueIngested: report.uniqueIngested,
        duplicatesSkipped: report.duplicatesSkipped,
        qualified: report.qualified,
        reviewRequired: report.reviewRequired,
        disqualified: report.disqualified,
        operatorId: operatorOf(request),
        correlationId,
      },
    }));

    response.status(201).json({
      status: 'completed',
      page,
      nextPage: page + 1,
      countries: countries ?? ['US'],
      positions: positions ?? ['Director'],
      keyword: keyword ?? 'recruitment',
      campaign: createdCampaign ? {
        id: createdCampaign.id,
        name: createdCampaign.name,
      } : null,
      ...report,
      correlationId,
    });
  } catch (error) {
    const correlationId = correlationOf(request);
    if (error instanceof XrayRateLimitedError) {
      return response.status(429).json({
        status: 'rate_limited',
        code: error.code,
        message: error.message,
        correlationId,
        retryAfterMs: error.retryAfterMs ?? null,
      });
    }
    if (error instanceof XrayBlockedError) {
      return response.status(502).json({ status: 'failed', code: error.code, message: error.message, correlationId, retryAfterMs: null });
    }
    if (error instanceof XrayNetworkError) {
      return response.status(502).json({ status: 'failed', code: error.code, message: error.message, correlationId, retryAfterMs: null });
    }
    response.status(500).json({ status: 'failed', discovered: 0, uniqueIngested: 0, duplicatesSkipped: 0, qualified: 0, reviewRequired: 0, disqualified: 0, queries: [], correlationId });
  }
});


app.get('/api/exports/approved.csv', async (request, response) => {
  const tenantId = tenantOf(request);
  const rows = await withRequestTenant(request, () => db.select().from(prospects).where(and(eq(prospects.tenantId, tenantId), eq(prospects.currentStage, 'READY_FOR_CAMPAIGN'))));
  const csv = stringify(rows.map(row => ({
    linkedinUrl: row.linkedinUrl,
    normalizedLinkedinUrl: row.normalizedLinkedinUrl,
    ...((row.customAttributes as Record<string, unknown>) ?? {}),
  })), { header: true });
  response.type('text/csv').set('Content-Disposition', 'attachment; filename="approved-prospects.csv"').send(csv);
});

// ─── Engagement routes ────────────────────────────────────────────────────────

app.get('/api/engagement/prospects', async (request, res) => {
  try {
    const tenantId = tenantOf(request);
    const rows = await withRequestTenant(request, () =>
      db.select().from(prospects).where(
        and(
          eq(prospects.tenantId, tenantId),
          eq(prospects.currentStage, 'READY_FOR_CAMPAIGN'),
        ),
      ).orderBy(desc(prospects.updatedAt)),
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json(structuredRefusal('PROSPECT_NOT_READY', errorResponse(err), correlationOf(request)));
  }
});

app.post('/api/engagement/scan', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const prospectId = typeof req.body?.prospectId === 'string' ? req.body.prospectId : '';
    if (!prospectId) return res.status(400).json(structuredRefusal('ICP_INVALID', 'prospectId is required', correlationOf(req)));
    const voiceProfile = typeof req.body?.voiceProfile === 'string' ? req.body.voiceProfile : undefined;
    const result = await withRequestTenant(req, () => engagementService.scanProspect(tenantId, prospectId, voiceProfile));
    res.json(result);
  } catch (err) {
    res.status(500).json(structuredRefusal('PROVIDER_UNAVAILABLE', errorResponse(err), correlationOf(req)));
  }
});

app.get('/api/engagement/posts', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const rows = await withRequestTenant(req, () =>
      withDbRetry(() => db.select().from(engagementPosts).where(eq(engagementPosts.tenantId, tenantId)).orderBy(desc(engagementPosts.createdAt)))
    );
    res.json(rows);
  } catch (err) {
    handleDbError(err, res, req, 'POST_NOT_ELIGIBLE', 500);
  }
});

app.get('/api/engagement/drafts', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const status = req.query.status as string | undefined;
    const drafts = status === 'ALL'
      ? await withRequestTenant(req, () => withDbRetry(() => engagementService.listAllDrafts(tenantId)))
      : await withRequestTenant(req, () => withDbRetry(() => engagementService.listPendingDrafts(tenantId)));

    const enriched = await withRequestTenant(req, () => Promise.all(
      drafts.map(async (draft) => {
        const post = await withDbRetry(() => db.query.engagementPosts.findFirst({
          where: eq(engagementPosts.id, draft.postId),
        }));
        return { ...draft, post };
      }),
    ));

    res.json(enriched);
  } catch (err) {
    handleDbError(err, res, req, 'POST_NOT_ELIGIBLE', 500);
  }
});

let scanResumeRunning = false;
app.post('/api/engagement/resume', async (req, res) => {
  if (scanResumeRunning) {
    return res.json({ status: 'already_running', correlationId: correlationOf(req) });
  }
  scanResumeRunning = true;
  try {
    const tenantId = tenantOf(req);
    const campaignId = typeof req.body?.campaignId === 'string' && req.body.campaignId.trim() !== ''
      ? req.body.campaignId.trim()
      : undefined;
    const result = await withRequestTenant(req, () =>
      engagementService.scanCampaignResume(tenantId, campaignId)
    );
    res.json({
      status: 'completed',
      prospectsScanned: result.prospectsScanned,
      draftsBackfilled: result.draftsBackfilled,
      errors: result.errors,
      correlationId: correlationOf(req),
    });
  } catch (err) {
    handleDbError(err, res, req, 'PROVIDER_UNAVAILABLE', 500);
  } finally {
    scanResumeRunning = false;
  }
});


app.post('/api/engagement/drafts/:id/decision', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const draftId = req.params.id;
    const decision = req.body?.decision as string;
    const validDecisions = ['APPROVED', 'EDITED', 'SKIPPED', 'REJECTED'];
    if (!validDecisions.includes(decision)) {
      return res.status(400).json(structuredRefusal('ICP_INVALID', `decision must be one of: ${validDecisions.join(', ')}`, correlationOf(req)));
    }
    if (decision === 'EDITED' && !req.body?.editedText) {
      return res.status(400).json(structuredRefusal('ICP_INVALID', 'editedText is required when decision is EDITED', correlationOf(req)));
    }

    const updated = await withRequestTenant(req, () => engagementService.applyReviewDecision({
      draftId,
      tenantId,
      decision: decision as 'APPROVED' | 'EDITED' | 'SKIPPED' | 'REJECTED',
      editedText: req.body?.editedText,
      operatorId: operatorOf(req),
    }));
    res.json(updated);
  } catch (err: unknown) {
    const message = errorResponse(err);
    const status = message?.includes('not found') ? 404 : 400;
    res.status(status).json(structuredRefusal('APPROVAL_REQUIRED', message, correlationOf(req)));
  }
});

app.post('/api/engagement/posts/:postId/recommendations', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    if (req.body?.actionType !== 'LIKE') return res.status(422).json(structuredRefusal('POST_NOT_ELIGIBLE', 'Only explicit LIKE recommendations are supported by this path', correlationOf(req)));
    const post = await withRequestTenant(req, () => db.query.engagementPosts.findFirst({ where: and(eq(engagementPosts.id, req.params.postId), eq(engagementPosts.tenantId, tenantId)) }));
    if (!post) return res.status(404).json(structuredRefusal('POST_NOT_ELIGIBLE', 'Post not found', correlationOf(req)));
    const result = await withRequestTenant(req, () => engagementService.createLikeRecommendation(tenantId, post.prospectId, post.id));
    res.status(201).json(result);
  } catch (err) {
    res.status(422).json(structuredRefusal('POST_NOT_ELIGIBLE', errorResponse(err), correlationOf(req)));
  }
});

app.post('/api/engagement/drafts/:id/complete', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const result = await withRequestTenant(req, () => engagementService.recordManualCompletion({
      draftId: req.params.id,
      tenantId,
      operatorId: operatorOf(req),
    }));
      res.status(result.status === 'PENDING_CONFIRMATION' ? 202 : 200).json({ success: result.outcomeLabel === 'manual-confirmed', ...result });
  } catch (err: unknown) {
    const message = errorResponse(err);
    const status = message?.includes('not found') ? 404 : 400;
    res.status(status).json(structuredRefusal('MANUAL_CONFIRMATION_PENDING', message, correlationOf(req)));
  }
});

async function ensureSupervisedDefaults(tenantId: string, accountId: string): Promise<void> {
  const existingAccount = await db.query.browserAccounts.findFirst({
    where: and(eq(browserAccounts.tenantId, tenantId), eq(browserAccounts.id, accountId)),
  });
  if (!existingAccount) {
    await db.insert(browserAccounts).values({
      id: accountId,
      tenantId,
      label: 'Default Browser Account',
      health: 'HEALTHY',
      sessionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }).onConflictDoNothing();
  } else if (existingAccount.health !== 'HEALTHY' || !existingAccount.sessionExpiresAt || existingAccount.sessionExpiresAt <= new Date()) {
    await db.update(browserAccounts).set({
      health: 'HEALTHY',
      sessionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    }).where(and(eq(browserAccounts.tenantId, tenantId), eq(browserAccounts.id, accountId)));
  }

  for (const actionType of ['LIKE', 'COMMENT'] as const) {
    const existingControl = await db.query.engagementControls.findFirst({
      where: and(eq(engagementControls.tenantId, tenantId), eq(engagementControls.accountId, accountId), eq(engagementControls.actionType, actionType)),
    });
    if (!existingControl) {
      await db.insert(engagementControls).values({
        tenantId,
        accountId,
        actionType,
        enabled: true,
        killSwitchActive: false,
      }).onConflictDoNothing();
    }
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const actionType of ['LIKE', 'COMMENT', 'like', 'comment']) {
    const existingBudget = await db.query.dailyActionBudgets.findFirst({
      where: and(
        eq(dailyActionBudgets.tenantId, tenantId),
        eq(dailyActionBudgets.accountId, accountId),
        eq(dailyActionBudgets.actionType, actionType),
        eq(dailyActionBudgets.budgetDate, today)
      ),
    });
    if (!existingBudget) {
      await db.insert(dailyActionBudgets).values({
        tenantId,
        accountId,
        actionType,
        budgetDate: today,
        limit: 50,
        reservedCount: 0,
        completedCount: 0,
      }).onConflictDoNothing();
    }
  }
}

app.post('/api/engagement/recommendations/:id/actions', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const actionType = req.body?.actionType;
    const mode = req.body?.mode;
    const accountId = req.body?.accountId ?? '00000000-0000-0000-0000-000000000002';
    const idempotencyKey = req.body?.idempotencyKey;
    await withRequestTenant(req, () => ensureSupervisedDefaults(tenantId, accountId));
    const result = await withRequestTenant(req, () => engagementService.requestAction({ draftId: req.params.id, tenantId, actionType, mode, accountId, idempotencyKey }));
    res.status(202).json({ ...result, queueStatus: 'pending', correlationId: correlationOf(req) });
  } catch (err: unknown) {
    const code = errorResponse(err);
    const status = code === 'ACTION_DUPLICATE' ? 409 : code === 'DRAFT_NOT_FOUND' ? 404 : 422;
    res.status(status).json({ status: 'refused', code, correlationId: correlationOf(req) });
  }
});

app.post('/api/manual-tasks/:id/outcome', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const result = await withRequestTenant(req, () => engagementService.recordManualCompletion({ taskId: req.params.id, tenantId, operatorId: operatorOf(req), outcome: req.body?.outcome, metadata: req.body?.metadata }));
    res.json({ success: result.outcomeLabel === 'manual-confirmed', ...result });
  } catch (err) {
    res.status(409).json({ status: 'refused', code: errorResponse(err), correlationId: correlationOf(req) });
  }
});

// ─── Supervised execution: controls, health, queue, audit ────────────────────

app.get('/api/engagement/controls', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : '00000000-0000-0000-0000-000000000002';
    await withRequestTenant(req, () => ensureSupervisedDefaults(tenantId, accountId));
    const rows = await withRequestTenant(req, () => db.select().from(engagementControls).where(eq(engagementControls.tenantId, tenantId)));
    res.json(req.query.accountId ? rows.filter(row => String((row as { accountId: unknown }).accountId) === accountId) : rows);
  } catch (err) {
    res.status(500).json(structuredRefusal('TENANT_FORBIDDEN', errorResponse(err), correlationOf(req)));
  }
});

app.post('/api/execution/kill-switches', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const { accountId, actionType, active } = req.body ?? {};
    if (!accountId || !actionType) return res.status(400).json(structuredRefusal('ICP_INVALID', 'accountId and actionType are required', correlationOf(req)));
    const rows = await withRequestTenant(req, () => db.update(engagementControls).set({ killSwitchActive: !!active, updatedAt: new Date() }).where(and(eq(engagementControls.tenantId, tenantId), eq(engagementControls.accountId, accountId), eq(engagementControls.actionType, actionType))).returning());
    await withRequestTenant(req, () => new DrizzleAdapter(db as never).insertAuditEvent({ tenantId, eventType: active ? 'kill_switch.activated' : 'kill_switch.cleared', entityType: 'engagement_control', entityId: accountId, payload: { actionType, operatorId: operatorOf(req), correlationId: correlationOf(req) } }));
    res.json({ status: rows[0] ? 'pending' : 'refused', control: rows[0] ?? null });
  } catch (err) {
    res.status(500).json(structuredRefusal('KILL_SWITCH_ACTIVE', errorResponse(err), correlationOf(req)));
  }
});

app.get('/api/execution/accounts/:id', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    await withRequestTenant(req, () => ensureSupervisedDefaults(tenantId, req.params.id));
    const account = await withRequestTenant(req, () => db.query.browserAccounts.findFirst({ where: and(eq(browserAccounts.id, req.params.id), eq(browserAccounts.tenantId, tenantId)) }));
    if (!account) return res.status(404).json(structuredRefusal('TENANT_FORBIDDEN', 'Account not found', correlationOf(req)));
    res.json({ ...account, browserEnabled: process.env.FEATURE_05_BROWSER_ENABLED === '1' });
  } catch (err) {
    res.status(500).json(structuredRefusal('TENANT_FORBIDDEN', errorResponse(err), correlationOf(req)));
  }
});

app.post('/api/execution/accounts/:id/stop', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const rows = await withRequestTenant(req, () => db.update(browserAccounts).set({ health: 'PAUSED', updatedAt: new Date() }).where(and(eq(browserAccounts.id, req.params.id), eq(browserAccounts.tenantId, tenantId))).returning());
    if (!rows[0]) return res.status(404).json(structuredRefusal('TENANT_FORBIDDEN', 'Account not found', correlationOf(req)));
    res.json({ status: 'pending', health: rows[0].health });
  } catch (err) {
    res.status(500).json(structuredRefusal('EXECUTION_FAILED', errorResponse(err), correlationOf(req)));
  }
});

app.post('/api/queue/process', async (req, res) => {
  if (scanResumeRunning || engagementService.isScanningActive) {
    return res.status(422).json({
      status: 'refused',
      code: 'SCANNING_IN_PROGRESS',
      message: 'Prospect scanning is currently active. Action queue processing is on hold.',
      correlationId: correlationOf(req),
    });
  }
  try {
    const tenantId = tenantOf(req);
    let { accountId, workerId, leaseToken, mode } = req.body ?? {};
    if (!accountId) accountId = '00000000-0000-0000-0000-000000000002';
    if (!workerId) workerId = 'operator-worker';
    await withRequestTenant(req, () => ensureSupervisedDefaults(tenantId, accountId));
    if (!leaseToken) {
      const lease = new LeaseService(new DrizzleAdapter(db as never));
      const res = await lease.acquireLeaseWithToken(tenantId, accountId, workerId, 300);
      if (res.acquired && res.leaseToken) leaseToken = res.leaseToken;
    }
    // Fail closed on executor mode mismatch. The executor is selected from the
    // claimed action's persisted mode, never from the untrusted request body:
    // a caller must not run browser writes on a queued SIMULATE action, nor
    // relabel a BROWSER action as SIMULATE. Peek the oldest pending action
    // (claim order) to bind the executor choice before dispatch.
    const pending = await withRequestTenant(req, () => db.query.scheduledActions.findFirst({
      where: and(eq(scheduledActions.tenantId, tenantId), eq(scheduledActions.accountId, accountId), eq(scheduledActions.status, 'PENDING')),
      orderBy: [asc(scheduledActions.scheduledFor), asc(scheduledActions.createdAt)],
    }));
    const persistedMode = pending ? String((pending as { mode?: unknown }).mode ?? 'SIMULATE').toUpperCase() : undefined;
    const requestedMode = mode === undefined || mode === null ? undefined : String(mode).toUpperCase();
    if (requestedMode && persistedMode && requestedMode !== persistedMode) {
      return res.status(422).json({ status: 'refused', code: 'EXECUTOR_MODE_MISMATCH', message: `Requested executor mode ${requestedMode} does not match queued action mode ${persistedMode}`, correlationId: correlationOf(req) });
    }
    const effectiveMode = persistedMode ?? requestedMode ?? 'SIMULATE';
    if (effectiveMode === 'BROWSER' && process.env.FEATURE_05_BROWSER_ENABLED !== '1') {
      return res.status(422).json({ status: 'refused', code: 'FEATURE_05_BROWSER_DISABLED', correlationId: correlationOf(req) });
    }
    const queue = buildQueueForMode(effectiveMode);
    const result = await withRequestTenant(req, () => queue.processNextAction(tenantId, accountId, workerId, leaseToken));
    res.json({ ...result, correlationId: correlationOf(req) });
  } catch (err) {
    if (errorResponse(err) === 'FEATURE_05_BROWSER_DISABLED') {
      return res.status(422).json({ status: 'refused', code: 'FEATURE_05_BROWSER_DISABLED', correlationId: correlationOf(req) });
    }
    res.status(500).json(structuredRefusal('EXECUTION_FAILED', errorResponse(err), correlationOf(req)));
  }
});

app.get('/api/queue/actions', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const rows = await withRequestTenant(req, () =>
      db.select({
        action: scheduledActions,
        prospectAttrs: prospects.customAttributes,
        prospectUrl: prospects.linkedinUrl,
        campaignName: campaigns.name,
      })
      .from(scheduledActions)
      .leftJoin(prospects, eq(scheduledActions.prospectId, prospects.id))
      .leftJoin(campaignEnrollments, eq(scheduledActions.campaignEnrollmentId, campaignEnrollments.id))
      .leftJoin(campaigns, eq(campaignEnrollments.campaignId, campaigns.id))
      .where(eq(scheduledActions.tenantId, tenantId))
      .orderBy(desc(scheduledActions.createdAt))
    );
    
    const enriched = rows.map(r => ({
      ...r.action,
      prospectName: (r.prospectAttrs as any)?.name || 'Unknown Prospect',
      prospectUrl: r.prospectUrl,
      campaignName: r.campaignName || 'Unknown Campaign'
    }));
    
    res.json(enriched.slice(0, 100));
  } catch (err) {
    res.status(500).json(structuredRefusal('TENANT_FORBIDDEN', errorResponse(err), correlationOf(req)));
  }
});

// Reset recently failed/falsely-completed comment actions so the UI can re-queue them.
app.post('/api/queue/retry-failed', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const windowHours = Number(req.body?.windowHours ?? 24);
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const result = await withRequestTenant(req, () =>
      db.update(scheduledActions)
        .set({ status: 'PENDING', errorCode: null, outcomeLabel: null, completedAt: null, claimToken: null, claimedBy: null, claimedAt: null })
        .where(
          and(
            eq(scheduledActions.tenantId, tenantId),
            eq(scheduledActions.status, 'FAILED'),
            gte(scheduledActions.createdAt, since)
          )
        )
        .returning({ id: scheduledActions.id })
    );
    res.json({ reset: result.length, ids: result.map(r => r.id), correlationId: correlationOf(req) });
  } catch (err) {
    res.status(500).json(structuredRefusal('EXECUTION_FAILED', errorResponse(err), correlationOf(req)));
  }
});

app.post('/api/queue/clear', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    // Delete all PENDING actions to stop the queue from processing further
    const result = await withRequestTenant(req, () =>
      db.delete(scheduledActions)
        .where(and(
          eq(scheduledActions.tenantId, tenantId),
          eq(scheduledActions.status, 'PENDING')
        ))
        .returning({ id: scheduledActions.id })
    );
    res.json({ cleared: result.length, ids: result.map(r => r.id), correlationId: correlationOf(req) });
  } catch (err) {
    res.status(500).json(structuredRefusal('EXECUTION_FAILED', errorResponse(err), correlationOf(req)));
  }
});

app.get('/api/execution/audit', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const rows = await withRequestTenant(req, () => db.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantId)).orderBy(desc(auditEvents.createdAt)));
    res.json(rows.slice(0, 100));
  } catch (err) {
    res.status(500).json(structuredRefusal('TENANT_FORBIDDEN', errorResponse(err), correlationOf(req)));
  }
});

// ─── Channel 4: Post keyword search + AI buying signals ───────────────────────

function buildContentSearchChannel(): { channel: ContentSearchChannel; provider: string } {
  const adapter = new DrizzleAdapter(db as never);
  const provider = process.env.GEMINI_API_KEY || process.env.CODEX_EVERYWHERE_API_KEY
    ? new LunaBuyingSignalProvider()
    : new FakeBuyingSignalProvider();
  return { channel: new ContentSearchChannel({
    runner: new OpenCliContentSearchRunner(),
    classifier: new BuyingSignalClassifier(provider),
    db: adapter,
    generateDrafts: (tenantId, prospectId, postId) =>
      engagementService.createLikeRecommendation(tenantId, prospectId, postId).then(() => undefined),
  }), provider: provider.providerName };
}

app.post('/api/discovery/content-search', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const body = req.body ?? {};
    const queries = Array.isArray(body.queries)
      ? body.queries.filter((q: unknown): q is string => typeof q === 'string' && q.trim().length > 0).map((q: string) => q.trim())
      : undefined;
    if (queries && queries.length > 5) {
      return res.status(400).json(structuredRefusal('DISCOVERY_INVALID', 'queries must contain at most 5 entries', correlationOf(req)));
    }
    const maxPostsPerQuery = body.maxPostsPerQuery === undefined ? undefined : Number(body.maxPostsPerQuery);
    if (maxPostsPerQuery !== undefined && (!Number.isInteger(maxPostsPerQuery) || maxPostsPerQuery < 1 || maxPostsPerQuery > 25)) {
      return res.status(400).json(structuredRefusal('DISCOVERY_INVALID', 'maxPostsPerQuery must be an integer between 1 and 25', correlationOf(req)));
    }
    const recency = body.recency === undefined ? undefined : String(body.recency);
    if (recency !== undefined && !['past-24h', 'past-week', 'past-month'].includes(recency)) {
      return res.status(400).json(structuredRefusal('DISCOVERY_INVALID', 'recency must be one of past-24h, past-week, past-month', correlationOf(req)));
    }
    const archetype = body.archetype === undefined ? undefined : String(body.archetype);
    if (archetype !== undefined && !['AGENCY_LEADERSHIP', 'HIRING_LEADER'].includes(archetype)) {
      return res.status(400).json(structuredRefusal('DISCOVERY_INVALID', 'archetype must be one of AGENCY_LEADERSHIP, HIRING_LEADER', correlationOf(req)));
    }
    const { channel, provider } = buildContentSearchChannel();
    const result = await withRequestTenant(req, () => channel.run(tenantId, {
      queries,
      recency: recency as 'past-24h' | 'past-week' | 'past-month' | undefined,
      archetype: archetype as 'AGENCY_LEADERSHIP' | 'HIRING_LEADER' | undefined,
      maxPostsPerQuery,
    }));
    res.status(201).json({ status: 'completed', provider, ...result, correlationId: correlationOf(req) });
  } catch (err) {
    res.status(500).json(structuredRefusal('DISCOVERY_FAILED', errorResponse(err), correlationOf(req)));
  }
});

app.get('/api/discovery/content-insights', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const adapter = new DrizzleAdapter(db as never);
    const rows = await withRequestTenant(req, () => adapter.findContentInsightsByTenant(tenantId));
    res.json({ insights: rows, correlationId: correlationOf(req) });
  } catch (err) {
    res.status(500).json(structuredRefusal('DISCOVERY_FAILED', errorResponse(err), correlationOf(req)));
  }
});

app.get('/api/discovery/buying-signals', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const adapter = new DrizzleAdapter(db as never);
    const rows = await withRequestTenant(req, () => adapter.findBuyingSignalsByTenant(tenantId));
    res.json({ signals: rows, correlationId: correlationOf(req) });
  } catch (err) {
    res.status(500).json(structuredRefusal('DISCOVERY_FAILED', errorResponse(err), correlationOf(req)));
  }
});

app.post('/api/prospects/:id/promote', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const adapter = new DrizzleAdapter(db as never);
    const result = await withRequestTenant(req, () =>
      promoteProspect(adapter, tenantId, req.params.id, operatorOf(req), typeof req.body?.reason === 'string' ? req.body.reason : undefined),
    );
    res.json({ ...result, correlationId: correlationOf(req) });
  } catch (err) {
    if (errorResponse(err) === 'PROSPECT_NOT_FOUND') {
      return res.status(404).json(structuredRefusal('PROSPECT_NOT_FOUND', 'Prospect not found', correlationOf(req)));
    }
    res.status(500).json(structuredRefusal('PROMOTION_FAILED', errorResponse(err), correlationOf(req)));
  }
});

// ─── Channel 5: Competitor & influencer post-engager sourcing ────────────────

function buildPostEngagerChannel(): PostEngagerChannel {
  const adapter = new DrizzleAdapter(db as never);
  return new PostEngagerChannel({
    runner: new OpenCliPostEngagerRunner(),
    db: adapter,
    registry: new EngagerTargetRegistry(adapter),
    engageProspect: (tenantId, prospectId) =>
      engagementService.scanProspect(tenantId, prospectId).then((scan) => ({
        draftsCreated: scan.draftsCreated,
        postsFound: scan.postsFound,
      })),
  });
}

app.get('/api/discovery/engager-targets', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const activeOnly = req.query.active === '1' || req.query.active === 'true';
    const adapter = new DrizzleAdapter(db as never);
    const registry = new EngagerTargetRegistry(adapter);
    const targets = await withRequestTenant(req, () => registry.list(tenantId, { activeOnly: activeOnly || undefined }));
    res.json({ targets, correlationId: correlationOf(req) });
  } catch (err) {
    res.status(500).json(structuredRefusal('TENANT_FORBIDDEN', errorResponse(err), correlationOf(req)));
  }
});

app.post('/api/discovery/engager-targets/seed', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const adapter = new DrizzleAdapter(db as never);
    const registry = new EngagerTargetRegistry(adapter);
    const result = await withRequestTenant(req, () => registry.seed(tenantId));
    res.status(201).json({ ...result, correlationId: correlationOf(req) });
  } catch (err) {
    res.status(500).json(structuredRefusal('SEED_FAILED', errorResponse(err), correlationOf(req)));
  }
});

app.patch('/api/discovery/engager-targets/:id', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    if (typeof req.body?.isActive !== 'boolean') {
      return res.status(400).json(structuredRefusal('TARGET_INVALID', 'isActive must be a boolean', correlationOf(req)));
    }
    const adapter = new DrizzleAdapter(db as never);
    const registry = new EngagerTargetRegistry(adapter);
    const target = await withRequestTenant(req, () => registry.setActive(tenantId, req.params.id, req.body.isActive));
    res.json({ target, correlationId: correlationOf(req) });
  } catch (err) {
    if (errorResponse(err) === 'TARGET_NOT_FOUND') {
      return res.status(404).json(structuredRefusal('TARGET_NOT_FOUND', 'Target not found', correlationOf(req)));
    }
    res.status(500).json(structuredRefusal('TARGET_INVALID', errorResponse(err), correlationOf(req)));
  }
});

app.post('/api/discovery/post-engagers', async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const body = req.body ?? {};

    const targetIds = Array.isArray(body.targetIds)
      ? body.targetIds.filter((t: unknown): t is string => typeof t === 'string' && t.trim().length > 0)
      : undefined;
    if (targetIds && targetIds.length > 11) {
      return res.status(400).json(structuredRefusal('DISCOVERY_INVALID', 'targetIds must contain at most 11 entries', correlationOf(req)));
    }

    const maxPostsPerTarget = body.maxPostsPerTarget === undefined ? undefined : Number(body.maxPostsPerTarget);
    if (maxPostsPerTarget !== undefined && (!Number.isInteger(maxPostsPerTarget) || maxPostsPerTarget < 1 || maxPostsPerTarget > 10)) {
      return res.status(400).json(structuredRefusal('DISCOVERY_INVALID', 'maxPostsPerTarget must be an integer between 1 and 10', correlationOf(req)));
    }

    const maxEngagersPerPost = body.maxEngagersPerPost === undefined ? undefined : Number(body.maxEngagersPerPost);
    if (maxEngagersPerPost !== undefined && (!Number.isInteger(maxEngagersPerPost) || maxEngagersPerPost < 1 || maxEngagersPerPost > 50)) {
      return res.status(400).json(structuredRefusal('DISCOVERY_INVALID', 'maxEngagersPerPost must be an integer between 1 and 50', correlationOf(req)));
    }

    const recency = body.recency === undefined ? undefined : String(body.recency);
    if (recency !== undefined && !['past-24h', 'past-week', 'past-month'].includes(recency)) {
      return res.status(400).json(structuredRefusal('DISCOVERY_INVALID', 'recency must be one of past-24h, past-week, past-month', correlationOf(req)));
    }

    const channel = buildPostEngagerChannel();
    const result = await withRequestTenant(req, () => channel.run(tenantId, {
      targetIds,
      recency: (recency as PostRecency | undefined) ?? 'past-week',
      maxPostsPerTarget: maxPostsPerTarget ?? undefined,
      maxEngagersPerPost: maxEngagersPerPost ?? undefined,
    }));
    res.status(201).json({ recency: recency ?? 'past-week', ...result, correlationId: correlationOf(req) });
  } catch (err) {
    const code = errorResponse(err);
    if (code === 'NO_ACTIVE_TARGETS' || code === 'TARGET_NOT_ACTIVE' || code === 'TARGET_NOT_FOUND') {
      return res.status(422).json(structuredRefusal(code, code === 'NO_ACTIVE_TARGETS' ? 'No active engager targets are configured' : 'One or more requested targets are inactive or unknown', correlationOf(req)));
    }
    res.status(500).json(structuredRefusal('DISCOVERY_FAILED', errorResponse(err), correlationOf(req)));
  }
});


// ─── Server-side auto-drain worker ───────────────────────────────────────────
// Processes one PENDING action every 300 seconds so the queue drains even if
// the browser tab is closed after clicking "Run Campaign".

const AUTO_DRAIN_GAP_MS = 300_000;
const AUTO_DRAIN_WORKER_ID = 'server-auto-drain-v1';
let autoDrainRunning = false;
let consecutiveSessionFailures = 0;

async function runAutoDrainCycle(): Promise<void> {
  if (autoDrainRunning) return; // Prevent concurrent runs
  
  if (scanResumeRunning || engagementService.isScanningActive) {
    console.log('[AutoDrain] ON HOLD: Prospect scanning is currently running. Skipping queue execution.');
    return;
  }

  if (consecutiveSessionFailures >= 3) {
    console.log('[AutoDrain] PAUSED due to 3 consecutive SESSION_EXPIRED errors. Please log in again and restart the server.');
    return;
  }
  
  autoDrainRunning = true;
  let leaseInfo: { tenantId: string; accountId: string; token: string } | undefined;

  try {
    // Find the oldest PENDING action to determine which tenant/account/mode to use
    const pending = await withDbRetry(() =>
      db.query.scheduledActions.findFirst({
        where: eq(scheduledActions.status, 'PENDING'),
        orderBy: [asc(scheduledActions.scheduledFor), asc(scheduledActions.createdAt)],
      })
    );
    if (!pending) return; // Nothing to do

    const tenantId = String(pending.tenantId);
    const accountId = String(pending.accountId);
    const persistedMode = String((pending as { mode?: unknown }).mode ?? 'SIMULATE').toUpperCase();

    if (persistedMode === 'BROWSER' && process.env.FEATURE_05_BROWSER_ENABLED !== '1') {
      console.log('[AutoDrain] Skipping: BROWSER mode is not enabled (set FEATURE_05_BROWSER_ENABLED=1).');
      return;
    }

    // Acquire a worker lease
    const adapter = new DrizzleAdapter(db as never);
    const leaseService = new LeaseService(adapter);
    const leaseResult = await withRequestTenantUnsafe(tenantId, () =>
      leaseService.acquireLeaseWithToken(tenantId, accountId, AUTO_DRAIN_WORKER_ID, 300)
    );
    if (!leaseResult.acquired || !leaseResult.leaseToken) {
      console.log('[AutoDrain] Could not acquire lease — another worker may be active.');
      return;
    }
    leaseInfo = { tenantId, accountId, token: leaseResult.leaseToken };

    // Process one action
    const queue = buildQueueForMode(persistedMode);
    const result = await withRequestTenantUnsafe(tenantId, () =>
      queue.processNextAction(tenantId, accountId, AUTO_DRAIN_WORKER_ID, leaseInfo!.token)
    );

    if (result.processed) {
      const errorCode = result.result?.errorCode ?? result.reason;
      const EXPECTED_REFUSAL_CODES = ['COOLDOWN_ACTIVE', 'BUDGET_EXCEEDED', 'RATE_LIMITED', 'OUTSIDE_WORKING_HOURS', 'WORKING_HOURS_CLOSED', 'KILL_SWITCH_ACTIVE', 'ACCOUNT_PAUSED', 'PILOT_CAP_REACHED', 'LIKE_DISABLED', 'COMMENT_DISABLED', 'FEATURE_05_BROWSER_DISABLED', 'LEASE_UNAVAILABLE', 'SESSION_EXPIRED'];
      const isExpected = !!errorCode && EXPECTED_REFUSAL_CODES.includes(String(errorCode));
      if (result.result?.outcomeLabel === 'failed' || result.reason) {
        if (isExpected) {
          console.log(
            `[AutoDrain] ⚠ ${result.action?.actionType?.toUpperCase()} → ${errorCode}`
          );
        } else {
          console.error(
            `[AutoDrain] ✗ ${result.action?.actionType?.toUpperCase()} FAILED → ${errorCode}`
          );
        }
      } else {
        console.log(
          `[AutoDrain] ✓ ${result.action?.actionType?.toUpperCase()} → ${result.result?.outcomeLabel ?? 'done'}`
        );
      }
      
      if (result.result?.outcomeLabel === 'failed' && result.result?.errorCode === 'SESSION_EXPIRED') {
        consecutiveSessionFailures++;
        console.log(`[AutoDrain] WARNING: Session expired (${consecutiveSessionFailures}/3)`);
      } else if (result.result?.outcomeLabel && result.result?.outcomeLabel !== 'failed') {
         // Reset consecutive errors if an action succeeds
         consecutiveSessionFailures = 0;

         // If they want 'one like and one comment' together, let's peek and see if the immediate next action belongs to the same prospect.
         const nextPending = await withDbRetry(() =>
           db.query.scheduledActions.findFirst({
             where: eq(scheduledActions.status, 'PENDING'),
             orderBy: [asc(scheduledActions.scheduledFor), asc(scheduledActions.createdAt)],
           })
         );
         
         if (nextPending && nextPending.prospectId === result.action?.prospectId) {
           console.log(`[AutoDrain] Found paired action for same prospect. Processing immediately...`);
           const result2 = await withRequestTenantUnsafe(tenantId, () =>
             queue.processNextAction(tenantId, accountId, AUTO_DRAIN_WORKER_ID, leaseInfo!.token)
           );
           if (result2.processed) {
             console.log(`[AutoDrain] ✓ ${result2.action?.actionType?.toUpperCase()} (paired) → ${result2.result?.outcomeLabel ?? result2.reason ?? 'done'}`);
           }
         }
      }
    } else {
      if (result.reason === 'DB_RETRYABLE') {
        console.log('[AutoDrain] Action returned to PENDING due to transient DB issue; will retry next cycle.');
      } else {
        console.log(`[AutoDrain] Queue empty or skipped: ${result.reason}`);
      }
    }
  } catch (err) {
    console.error('[AutoDrain] Error:', (err as Error).message);
  } finally {
    if (leaseInfo) {
      try {
        const adapter = new DrizzleAdapter(db as never);
        const leaseService = new LeaseService(adapter);
        await withRequestTenantUnsafe(leaseInfo.tenantId, () => 
          leaseService.releaseLease(leaseInfo!.tenantId, leaseInfo!.accountId, AUTO_DRAIN_WORKER_ID, leaseInfo!.token)
        );
      } catch (releaseErr) {
        console.warn('[AutoDrain] Failed to release lease in finally block:', (releaseErr as Error).message);
      }
    }
    autoDrainRunning = false;
  }
}

// Status endpoint so the UI can confirm the auto-drain worker is alive
app.get('/api/queue/drain/status', (_req, res) => {
  res.json({
    autoDrainEnabled: true,
    gapSeconds: AUTO_DRAIN_GAP_MS / 1000,
    workerId: AUTO_DRAIN_WORKER_ID,
    paused: consecutiveSessionFailures >= 3,
    onHold: scanResumeRunning || engagementService.isScanningActive,
  });
});

let autoApproveRunning = false;
async function autoApproveAndQueueCycle(): Promise<void> {
  if (autoApproveRunning) return;
  if (scanResumeRunning || engagementService.isScanningActive) return;
  autoApproveRunning = true;
  try {
    // Check if the queue already has PENDING items. If it does, wait for it to drain first.
    const existingQueueCount = await withDbRetry(() =>
      db.query.scheduledActions.findMany({
        where: eq(scheduledActions.status, 'PENDING'),
        limit: 50,
        orderBy: [asc(scheduledActions.createdAt)]
      })
    );
    
    if (existingQueueCount.length > 0) {
      return;
    }

    const pendingDrafts = await withDbRetry(() =>
      db.query.engagementDrafts.findMany({
        where: eq(engagementDrafts.status, 'PENDING'),
        limit: 50,
        orderBy: [asc(engagementDrafts.createdAt)]
      })
    );

    const approvedDrafts = await withDbRetry(() =>
      db.query.engagementDrafts.findMany({
        where: eq(engagementDrafts.status, 'APPROVED'),
        limit: 50,
        orderBy: [asc(engagementDrafts.createdAt)]
      })
    );

    const allDrafts = [
      ...pendingDrafts.map((d) => ({ draft: d, needsApproval: true })),
      ...approvedDrafts.map((d) => ({ draft: d, needsApproval: false })),
    ];

    if (allDrafts.length === 0) return;

    // ── OPTIMIZATION: Sort drafts by prospect ICP score desc ─────────────────
    // Fetch the latest ICP score for each unique prospect, then sort the
    // combined draft list: highest-score prospects go first, ensuring we take
    // action on the most valuable leads before lower-priority ones.
    const prospectIds = [...new Set(allDrafts.map((d) => d.draft.prospectId).filter(Boolean))];
    const scoreMap = new Map<string, number>();

    await Promise.all(
      prospectIds.map(async (pid) => {
        try {
          const eval_ = await withDbRetry(() =>
            db.query.icpEvaluations.findFirst({
              where: eq(icpEvaluations.prospectId, pid!),
              orderBy: [desc(icpEvaluations.createdAt)],
            })
          );
          scoreMap.set(pid!, eval_?.score ?? 0);
        } catch {
          scoreMap.set(pid!, 0);
        }
      })
    );

    const draftsToProcess = allDrafts.sort((a, b) => {
      const scoreA = scoreMap.get(a.draft.prospectId ?? '') ?? 0;
      const scoreB = scoreMap.get(b.draft.prospectId ?? '') ?? 0;
      if (scoreB !== scoreA) return scoreB - scoreA; // higher score first
      // Tiebreak: newer drafts first (most recently discovered prospects)
      return new Date(b.draft.createdAt).getTime() - new Date(a.draft.createdAt).getTime();
    });
    
    if (draftsToProcess.length > 0) {
      console.log(`[AutoQueue] Processing ${pendingDrafts.length} pending and ${approvedDrafts.length} approved drafts...`);
    }
    
    for (const { draft, needsApproval } of draftsToProcess) {
      const tenantId = String(draft.tenantId);
      
      // 1. Approve if needed
      if (needsApproval) {
        await withDbRetry(() =>
          withRequestTenantUnsafe(tenantId, () => 
            engagementService.applyReviewDecision({
              draftId: draft.id,
              tenantId,
              decision: 'APPROVED',
              operatorId: 'system-auto'
            })
          )
        );
      }
      
      // 2. Queue
      const mode = process.env.FEATURE_05_BROWSER_ENABLED === '1' ? 'BROWSER' : 'SIMULATE';
      const accountId = '00000000-0000-0000-0000-000000000002'; // default
      await withDbRetry(() =>
        withRequestTenantUnsafe(tenantId, () => ensureSupervisedDefaults(tenantId, accountId))
      );
      
      try {
        await withDbRetry(() =>
          withRequestTenantUnsafe(tenantId, () =>
            engagementService.requestAction({
              draftId: draft.id,
              tenantId,
              actionType: draft.actionType as 'LIKE' | 'COMMENT',
              mode,
              accountId,
              idempotencyKey: `auto-${draft.id}`
            })
          )
        );
        console.log(`[AutoQueue] Automatically queued ${draft.actionType} for draft ${draft.id}`);
      } catch (err: any) {
        if (
          err.message !== 'ACTION_DUPLICATE' &&
          err.message !== 'POST_ALREADY_COMMENTED' &&
          err.message !== 'POST_EXECUTION_UNCERTAIN' &&
          err.message !== 'POST_NOT_ELIGIBLE'
        ) {
          console.error(`[AutoQueue] Failed to queue draft ${draft.id}:`, err);
        }
      }
    }
  } catch (err) {
    console.error(`[AutoQueue] Cycle failed:`, (err as Error).message);
  } finally {
    autoApproveRunning = false;
  }
}

async function runScanResumeCycle(): Promise<void> {
  if (scanResumeRunning) return;
  scanResumeRunning = true;
  try {
    const result = await engagementService.scanCampaignResume();
    if (result.prospectsScanned > 0 || result.draftsBackfilled > 0) {
      console.log(`[ScanResume] Periodic resume completed: scanned ${result.prospectsScanned} prospects, backfilled ${result.draftsBackfilled} drafts.`);
    }
  } catch (err) {
    console.error('[ScanResume] Periodic resume cycle error:', (err as Error).message);
  } finally {
    scanResumeRunning = false;
  }
}

if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  setInterval(runAutoDrainCycle, AUTO_DRAIN_GAP_MS);
  setInterval(autoApproveAndQueueCycle, 30_000); // Check for new drafts every 30s
  setInterval(runScanResumeCycle, 10 * 60 * 1000); // Scan resume worker every 10m
  console.log(`[AutoDrain] Server-side queue drain worker started (gap: ${AUTO_DRAIN_GAP_MS / 1000}s)`);
  console.log(`[AutoQueue] Auto-approve and queue worker started (every 30s)`);
  console.log(`[ScanResume] Campaign scan resume worker started (every 10m)`);
  listenWithFallback(port);
}


function listenWithFallback(startPort: number, attemptsLeft = 10): void {
  const server = app.listen(startPort, () => {
    console.log(`RecruitmentOS ICP server listening on http://localhost:${startPort}`);
    try {
      fs.writeFileSync(path.join(process.cwd(), '.server-port'), String(startPort), 'utf-8');
    } catch (error) {
      console.error(`Failed to write .server-port file: ${error instanceof Error ? error.message : error}`);
    }
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err?.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`Port ${startPort} is in use, trying port ${startPort + 1}...`);
      listenWithFallback(startPort + 1, attemptsLeft - 1);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
}

export default app;
