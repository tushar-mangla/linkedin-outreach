import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, desc, eq } from 'drizzle-orm';
import * as schema from '../../db/schema.js';
import { EngagementService } from './engagement-service.js';
import type { ProspectPostSource } from './prospect-post-source.js';
import type { EngagementAIProvider } from './engagement-ai-provider.js';
import { canonicalPostIdentifier } from './post-identity.js';

// EngagementService reads the shared drizzle client directly, so redirect it to
// an isolated in-memory PGlite database migrated from ./drizzle. No DATABASE_URL,
// provider, browser, or LinkedIn access is used.
const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../../db/client.js', () => holder);

let testDb!: PgliteDatabase<typeof schema>;

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000002';
const OPERATOR_ID = '00000000-0000-0000-0000-000000000009';

function buildService(): EngagementService {
  const mockPostSource: ProspectPostSource = {
    sourceType: 'PLAYWRIGHT',
    findRecentPosts: async () => [
      {
        postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/?trk=feed',
        postText: 'We need to understand artificial intelligence scaling laws better to succeed with data-driven hiring approaches this year.',
        authorName: 'Test Author',
        publishedAtDate: new Date(),
      },
    ],
  };
  const mockAiProvider: EngagementAIProvider = {
    providerName: 'fake',
    generateComment: async () => ({
      commentText: 'Great insights on scaling laws and hiring approaches!',
      groundingEvidence: 'artificial intelligence scaling laws',
    }),
  };
  return new EngagementService({
    postSource: mockPostSource,
    aiProvider: mockAiProvider,
  });
}

async function createProspectWithPost(postHash: string, postUrl: string) {
  const [prospect] = await testDb
    .insert(schema.prospects)
    .values({
      id: randomUUID(),
      tenantId: TENANT_ID,
      linkedinUrl: `https://linkedin.com/in/prospect-${randomUUID()}`,
      normalizedLinkedinUrl: `https://linkedin.com/in/prospect-${randomUUID()}`,
      currentStage: 'READY_FOR_CAMPAIGN',
    })
    .returning();
  const [post] = await testDb
    .insert(schema.engagementPosts)
    .values({
      id: randomUUID(),
      tenantId: TENANT_ID,
      prospectId: prospect.id,
      postUrl,
      canonicalPostIdentifier: canonicalPostIdentifier(postUrl),
      postText:
        'We need to understand artificial intelligence scaling laws better to succeed with data-driven hiring approaches this year.',
      authorName: 'Fixture Author',
      contentHash: postHash,
    })
    .returning();
  return { prospect, post };
}

async function createDraft(postId: string, prospectId: string) {
  const [draft] = await testDb
    .insert(schema.engagementDrafts)
    .values({
      id: randomUUID(),
      tenantId: TENANT_ID,
      postId,
      prospectId,
      actionType: 'COMMENT',
      commentText: 'Initial draft comment for review.',
      status: 'PENDING',
      provider: 'fake',
    })
    .returning();
  const post = await testDb.query.engagementPosts.findFirst({
    where: eq(schema.engagementPosts.id, postId),
  });
  await testDb.insert(schema.recommendationRevisions).values({
    id: randomUUID(),
    tenantId: TENANT_ID,
    draftId: draft.id,
    revision: 1,
    actionType: 'COMMENT',
    postHash: post!.contentHash,
    commentText: 'Initial draft comment for review.',
    evidence: { source: 'test' },
    validationReport: { valid: true, reasons: [] },
    state: 'PENDING',
  });
  return draft;
}

async function prepareCommentRequest(postHash = 'c'.repeat(64), postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${Math.floor(Math.random() * 1e12)}/?trk=feed`) {
  const { post } = await createProspectWithPost(postHash, postUrl);
  const draft = await createDraft(post.id, post.prospectId);
  const service = buildService();
  await service.applyReviewDecision({ draftId: draft.id, tenantId: TENANT_ID, decision: 'APPROVED', operatorId: OPERATOR_ID });
  await testDb.insert(schema.engagementControls).values({ tenantId: TENANT_ID, accountId: ACCOUNT_ID, actionType: 'COMMENT', enabled: true }).onConflictDoNothing();
  await testDb.insert(schema.browserAccounts).values({ id: ACCOUNT_ID, tenantId: TENANT_ID, label: 'test', health: 'HEALTHY', sessionExpiresAt: new Date(Date.now() + 60_000) }).onConflictDoNothing();
  const budgetDate = new Date(); budgetDate.setHours(0, 0, 0, 0);
  await testDb.insert(schema.dailyActionBudgets).values({ tenantId: TENANT_ID, accountId: ACCOUNT_ID, actionType: 'COMMENT', budgetDate, limit: 10 }).onConflictDoNothing();
  return { service, post, draft };
}

beforeAll(async () => {
  const client = new PGlite();
  await client.waitReady;
  // Apply the forward migration chain with plain exec: the drizzle migrator
  // sends multi-statement breakpoint chunks as prepared statements, which
  // PGlite rejects. exec() runs each migration file verbatim instead.
  const files = fs
    .readdirSync(path.join(process.cwd(), 'drizzle'))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await client.exec(fs.readFileSync(path.join(process.cwd(), 'drizzle', file), 'utf8'));
  }
  testDb = drizzle(client, { schema });
  (holder as { db: unknown }).db = testDb;
}, 120000);

describe('engagement-service approvals and manual completion', () => {
  it('canonicalizes native activity URLs and tracking variants to one identity', () => {
    expect(canonicalPostIdentifier('https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/?trk=feed')).toBe('linkedin:activity:7123456789012345678');
    expect(canonicalPostIdentifier('https://linkedin.com/feed/update/urn:li:activity:7123456789012345678/#comment')).toBe('linkedin:activity:7123456789012345678');
  });

  it('allows exactly one concurrent comment claim for a canonical post', async () => {
    const { service, draft, post } = await prepareCommentRequest();
    const competingDraft = await createDraft(post.id, post.prospectId);
    await service.applyReviewDecision({ draftId: competingDraft.id, tenantId: TENANT_ID, decision: 'APPROVED', operatorId: OPERATOR_ID });
    const results = await Promise.allSettled([
      service.requestAction({ draftId: draft.id, tenantId: TENANT_ID, accountId: ACCOUNT_ID, actionType: 'COMMENT', mode: 'SIMULATE', idempotencyKey: 'first' }),
      buildService().requestAction({ draftId: competingDraft.id, tenantId: TENANT_ID, accountId: ACCOUNT_ID, actionType: 'COMMENT', mode: 'SIMULATE', idempotencyKey: 'second' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected').map((result) => (result as PromiseRejectedResult).reason.message)).toContain('POST_ALREADY_COMMENTED');
    expect(await testDb.query.accountPostComments.findMany({ where: eq(schema.accountPostComments.tenantId, TENANT_ID) })).toHaveLength(1);
    expect(await testDb.query.scheduledActions.findMany({ where: eq(schema.scheduledActions.prospectId, draft.prospectId) })).toHaveLength(1);
  });

  it('refuses a delayed competing request and never retries an uncertain slot', async () => {
    const { service, draft, post } = await prepareCommentRequest('d'.repeat(64));
    await service.requestAction({ draftId: draft.id, tenantId: TENANT_ID, accountId: ACCOUNT_ID, actionType: 'COMMENT', mode: 'SIMULATE', idempotencyKey: 'first' });
    const competingDraft = await createDraft(post.id, post.prospectId);
    await service.applyReviewDecision({ draftId: competingDraft.id, tenantId: TENANT_ID, decision: 'APPROVED', operatorId: OPERATOR_ID });
    await expect(service.requestAction({ draftId: competingDraft.id, tenantId: TENANT_ID, accountId: ACCOUNT_ID, actionType: 'COMMENT', mode: 'SIMULATE', idempotencyKey: 'revision' })).rejects.toThrow('POST_ALREADY_COMMENTED');
    const action = await testDb.query.scheduledActions.findFirst({ where: eq(schema.scheduledActions.prospectId, post.prospectId) });
    await testDb.update(schema.accountPostComments).set({ status: 'UNCERTAIN' }).where(eq(schema.accountPostComments.scheduledActionId, action!.id));
    await testDb.update(schema.scheduledActions).set({ status: 'UNCERTAIN' }).where(eq(schema.scheduledActions.id, action!.id));
    await expect(service.requestAction({ draftId: draft.id, tenantId: TENANT_ID, accountId: ACCOUNT_ID, actionType: 'COMMENT', mode: 'SIMULATE', idempotencyKey: 'first' })).rejects.toThrow('POST_EXECUTION_UNCERTAIN');
    await expect(service.requestAction({ draftId: competingDraft.id, tenantId: TENANT_ID, accountId: ACCOUNT_ID, actionType: 'COMMENT', mode: 'SIMULATE', idempotencyKey: 'uncertain' })).rejects.toThrow('POST_EXECUTION_UNCERTAIN');
  });

  it('skips posts with an existing comment slot and keeps a prospect to one active comment candidate', async () => {
    const [prospect] = await testDb.insert(schema.prospects).values({
      id: randomUUID(),
      tenantId: TENANT_ID,
      linkedinUrl: `https://linkedin.com/in/repeat-${randomUUID()}`,
      normalizedLinkedinUrl: `https://linkedin.com/in/repeat-${randomUUID()}`,
      currentStage: 'READY_FOR_CAMPAIGN',
    }).returning();
    const postUrls = [1, 2, 3].map((index) => `https://www.linkedin.com/feed/update/urn:li:activity:71234567890123456${index}/?trk=feed`);
    const [alreadyCommentedPost] = await testDb.insert(schema.engagementPosts).values({
      id: randomUUID(), tenantId: TENANT_ID, prospectId: prospect.id, postUrl: postUrls[0],
      canonicalPostIdentifier: canonicalPostIdentifier(postUrls[0]), postText: 'We need to understand artificial intelligence scaling laws better to succeed with data-driven hiring approaches this year.',
      authorName: 'Fixture Author', contentHash: 'e'.repeat(64),
    }).returning();
    await testDb.insert(schema.accountPostComments).values({
      tenantId: TENANT_ID, accountId: ACCOUNT_ID, postHash: alreadyCommentedPost.contentHash,
      canonicalPostIdentifier: alreadyCommentedPost.canonicalPostIdentifier, postUrl: alreadyCommentedPost.postUrl,
      status: 'COMPLETED',
    });
    const service = new EngagementService({
      postSource: {
        sourceType: 'PLAYWRIGHT',
        findRecentPosts: async () => postUrls.map((postUrl, index) => ({
          postUrl,
          postText: `We need to understand artificial intelligence scaling laws better to succeed with data-driven hiring approaches this year, especially topic ${index}.`,
          authorName: 'Fixture Author',
          publishedAt: new Date(),
        })),
      },
      aiProvider: {
        providerName: 'fake',
        generateComment: async () => ({ commentText: 'Great insights on scaling laws and hiring approaches!', groundingEvidence: 'scaling laws' }),
      },
    });

    const result = await service.scanProspect(TENANT_ID, prospect.id);
    const slotDrafts = await testDb.query.engagementDrafts.findMany({ where: eq(schema.engagementDrafts.postId, alreadyCommentedPost.id) });
    const commentDrafts = await testDb.query.engagementDrafts.findMany({ where: and(eq(schema.engagementDrafts.prospectId, prospect.id), eq(schema.engagementDrafts.actionType, 'COMMENT')) });

    expect(slotDrafts).toHaveLength(0);
    expect(commentDrafts).toHaveLength(1);
    expect(result.draftsCreated).toBe(2); // 1 LIKE + 1 COMMENT for the single selected post

    // Repeat scan for the same prospect when 1 active comment candidate already exists
    const repeatScanResult = await service.scanProspect(TENANT_ID, prospect.id);
    expect(repeatScanResult.draftsCreated).toBe(0);
    const totalCommentDrafts = await testDb.query.engagementDrafts.findMany({ where: and(eq(schema.engagementDrafts.prospectId, prospect.id), eq(schema.engagementDrafts.actionType, 'COMMENT')) });
    expect(totalCommentDrafts).toHaveLength(1);
  });

  it('skips comment draft creation when prospect has a completed comment within 14 days in engagement_history', async () => {
    const [prospect] = await testDb.insert(schema.prospects).values({
      id: randomUUID(),
      tenantId: TENANT_ID,
      linkedinUrl: `https://linkedin.com/in/cooldown-${randomUUID()}`,
      normalizedLinkedinUrl: `https://linkedin.com/in/cooldown-${randomUUID()}`,
      currentStage: 'READY_FOR_CAMPAIGN',
    }).returning();
    const postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:7123456789012349999/?trk=feed`;
    const [priorPost] = await testDb.insert(schema.engagementPosts).values({
      id: randomUUID(),
      tenantId: TENANT_ID,
      prospectId: prospect.id,
      postUrl: `https://www.linkedin.com/feed/update/urn:li:activity:7123456789012348888/?trk=feed`,
      canonicalPostIdentifier: 'linkedin:activity:7123456789012348888',
      postText: 'Prior post that was commented on',
      authorName: 'Fixture Author',
      contentHash: '9'.repeat(64),
    }).returning();

    // 5 days ago completed comment in engagement_history
    await testDb.insert(schema.engagementHistory).values({
      id: randomUUID(),
      tenantId: TENANT_ID,
      prospectId: prospect.id,
      postId: priorPost.id,
      actionType: 'COMMENT',
      interactedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      operatorId: OPERATOR_ID,
    });

    const service = new EngagementService({
      postSource: {
        sourceType: 'PLAYWRIGHT',
        findRecentPosts: async () => [{
          postUrl,
          postText: 'Fresh post about technology leadership and recruitment best practices.',
          authorName: 'Fixture Author',
          publishedAt: new Date(),
        }],
      },
      aiProvider: {
        providerName: 'fake',
        generateComment: async () => ({ commentText: 'Insightful thoughts on leadership!', groundingEvidence: 'leadership' }),
      },
    });

    const result = await service.scanProspect(TENANT_ID, prospect.id);
    expect(result.skippedByCooldown).toBe(1);
    expect(result.draftsCreated).toBe(0);
  });

  it('allows comment draft creation when the completed comment in engagement_history is older than 14 days', async () => {
    const [prospect] = await testDb.insert(schema.prospects).values({
      id: randomUUID(),
      tenantId: TENANT_ID,
      linkedinUrl: `https://linkedin.com/in/expired-cooldown-${randomUUID()}`,
      normalizedLinkedinUrl: `https://linkedin.com/in/expired-cooldown-${randomUUID()}`,
      currentStage: 'READY_FOR_CAMPAIGN',
    }).returning();
    const postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:7123456789012347777/?trk=feed`;
    const [priorPost] = await testDb.insert(schema.engagementPosts).values({
      id: randomUUID(),
      tenantId: TENANT_ID,
      prospectId: prospect.id,
      postUrl: `https://www.linkedin.com/feed/update/urn:li:activity:7123456789012346666/?trk=feed`,
      canonicalPostIdentifier: 'linkedin:activity:7123456789012346666',
      postText: 'Old post that was commented on 15 days ago',
      authorName: 'Fixture Author',
      contentHash: '8'.repeat(64),
    }).returning();

    // 15 days ago completed comment in engagement_history (cooldown expired)
    await testDb.insert(schema.engagementHistory).values({
      id: randomUUID(),
      tenantId: TENANT_ID,
      prospectId: prospect.id,
      postId: priorPost.id,
      actionType: 'COMMENT',
      interactedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
      operatorId: OPERATOR_ID,
    });

    const service = new EngagementService({
      postSource: {
        sourceType: 'PLAYWRIGHT',
        findRecentPosts: async () => [{
          postUrl,
          postText: 'Fresh post about technology leadership and recruitment best practices.',
          authorName: 'Fixture Author',
          publishedAt: new Date(),
        }],
      },
      aiProvider: {
        providerName: 'fake',
        generateComment: async () => ({ commentText: 'Insightful thoughts on leadership!', groundingEvidence: 'leadership' }),
      },
    });

    const result = await service.scanProspect(TENANT_ID, prospect.id);
    expect(result.skippedByCooldown).toBe(0);
    expect(result.draftsCreated).toBe(2); // 1 LIKE + 1 COMMENT
  });

  it('returns POST_EXECUTION_UNCERTAIN when requesting the exact same draft after becoming uncertain', async () => {
    const { service, draft, post } = await prepareCommentRequest('f'.repeat(64));
    await service.requestAction({ draftId: draft.id, tenantId: TENANT_ID, accountId: ACCOUNT_ID, actionType: 'COMMENT', mode: 'SIMULATE', idempotencyKey: 'same-draft' });
    const action = await testDb.query.scheduledActions.findFirst({ where: eq(schema.scheduledActions.prospectId, post.prospectId) });
    await testDb.update(schema.accountPostComments).set({ status: 'UNCERTAIN' }).where(eq(schema.accountPostComments.scheduledActionId, action!.id));
    await testDb.update(schema.scheduledActions).set({ status: 'UNCERTAIN' }).where(eq(schema.scheduledActions.id, action!.id));

    // Repeat request using the exact same draft/key after UNCERTAIN
    await expect(service.requestAction({
      draftId: draft.id,
      tenantId: TENANT_ID,
      accountId: ACCOUNT_ID,
      actionType: 'COMMENT',
      mode: 'SIMULATE',
      idempotencyKey: 'same-draft',
    })).rejects.toThrow('POST_EXECUTION_UNCERTAIN');
  });
  it('invalidates only the edited draft approval (scoped invalidation)', async () => {
    const service = buildService();
    const postHash = 'a'.repeat(64);
    const postUrlScoped = `https://www.linkedin.com/feed/update/urn:li:activity:${Math.floor(9000000000000000000 + Math.random() * 999999999999)}/?trk=feed`;
    const { post } = await createProspectWithPost(postHash, postUrlScoped);
    const draftA = await createDraft(post.id, post.prospectId);
    const draftB = await createDraft(post.id, post.prospectId);

    await service.applyReviewDecision({ draftId: draftA.id, tenantId: TENANT_ID, decision: 'APPROVED', operatorId: OPERATOR_ID });
    await service.applyReviewDecision({ draftId: draftB.id, tenantId: TENANT_ID, decision: 'APPROVED', operatorId: OPERATOR_ID });

    await service.applyReviewDecision({
      draftId: draftA.id,
      tenantId: TENANT_ID,
      decision: 'EDITED',
      editedText:
        'The perspective on artificial intelligence scaling laws resonates — the emphasis on data-driven approaches specifically mirrors what high-growth teams have shared recently.',
      operatorId: OPERATOR_ID,
    });

    // Draft A: latest revision is a new PENDING revision; prior revision superseded.
    const revisionsA = await testDb.query.recommendationRevisions.findMany({
      where: and(
        eq(schema.recommendationRevisions.draftId, draftA.id),
        eq(schema.recommendationRevisions.tenantId, TENANT_ID),
      ),
      orderBy: [desc(schema.recommendationRevisions.revision)],
    });
    expect(revisionsA).toHaveLength(2);
    expect(revisionsA[0].state).toBe('PENDING');
    expect(revisionsA[0].revision).toBe(2);
    expect(revisionsA[1].state).toBe('SUPERSEDED');

    // Draft A approvals invalidated; draft A reopened for review.
    const approvalsA = await testDb.query.recommendationApprovals.findMany({
      where: and(
        eq(schema.recommendationApprovals.tenantId, TENANT_ID),
        eq(schema.recommendationApprovals.revisionId, revisionsA[1].id),
      ),
    });
    expect(approvalsA).toHaveLength(1);
    expect(approvalsA[0].state).toBe('INVALIDATED');
    const updatedA = await testDb.query.engagementDrafts.findFirst({
      where: eq(schema.engagementDrafts.id, draftA.id),
    });
    expect(updatedA!.status).toBe('PENDING');

    // Draft B remains approved: revision and approval untouched.
    const revisionsB = await testDb.query.recommendationRevisions.findMany({
      where: and(
        eq(schema.recommendationRevisions.draftId, draftB.id),
        eq(schema.recommendationRevisions.tenantId, TENANT_ID),
      ),
    });
    expect(revisionsB).toHaveLength(1);
    expect(revisionsB[0].state).toBe('APPROVED');
    const approvalsB = await testDb.query.recommendationApprovals.findMany({
      where: and(
        eq(schema.recommendationApprovals.tenantId, TENANT_ID),
        eq(schema.recommendationApprovals.revisionId, revisionsB[0].id),
      ),
    });
    expect(approvalsB).toHaveLength(1);
    expect(approvalsB[0].state).toBe('APPROVED');
    const updatedB = await testDb.query.engagementDrafts.findFirst({
      where: eq(schema.engagementDrafts.id, draftB.id),
    });
    expect(updatedB!.status).toBe('APPROVED');
  });

  it.each([
    { outcome: 'COMPLETED', outcomeLabel: 'manual-confirmed', actionStatus: 'COMPLETED' },
    { outcome: 'FAILED', outcomeLabel: 'failed', actionStatus: 'FAILED' },
    { outcome: 'UNCERTAIN', outcomeLabel: 'uncertain', actionStatus: 'UNCERTAIN' },
  ] as const)('manual completion $outcome transitions the linked action and owned slot to $actionStatus', async ({ outcome, outcomeLabel, actionStatus }) => {
    const service = buildService();
    const postHash = 'b'.repeat(64);
    const postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${Math.floor(9000000000000000000 + Math.random() * 999999999999)}/?trk=feed`;
    const { post } = await createProspectWithPost(postHash, postUrl);

    const [action] = await testDb
      .insert(schema.scheduledActions)
      .values({
        id: randomUUID(),
        tenantId: TENANT_ID,
        prospectId: post.prospectId,
        accountId: ACCOUNT_ID,
        actionType: 'comment',
        payload: { postUrl: post.postUrl },
        scheduledFor: new Date(Date.now() - 1000),
        status: 'CLAIMED',
        idempotencyKey: `manual-lifecycle-${randomUUID()}`,
        postHash,
        mode: 'MANUAL',
      })
      .returning();
    const [task] = await testDb
      .insert(schema.manualTasks)
      .values({
        id: randomUUID(),
        tenantId: TENANT_ID,
        scheduledActionId: action.id,
        actionType: 'LIKE',
        status: 'PENDING_CONFIRMATION',
      })
      .returning();
    await testDb.insert(schema.accountPostComments).values({
      tenantId: TENANT_ID, accountId: ACCOUNT_ID, postHash,
      canonicalPostIdentifier: post.canonicalPostIdentifier, postUrl: post.postUrl,
      scheduledActionId: action.id, status: 'PENDING',
    });

    const result = await service.recordManualCompletion({
      taskId: task.id,
      tenantId: TENANT_ID,
      operatorId: OPERATOR_ID,
      outcome,
    });

    expect(result.status).toBe(outcome);
    expect(result.taskId).toBe(task.id);
    expect(result.outcomeLabel).toBe(outcomeLabel);

    const storedTask = await testDb.query.manualTasks.findFirst({
      where: eq(schema.manualTasks.id, task.id),
    });
    expect(storedTask!.status).toBe(outcome);
    expect(storedTask!.outcomeLabel).toBe(outcomeLabel);

    const storedAction = await testDb.query.scheduledActions.findFirst({
      where: eq(schema.scheduledActions.id, action.id),
    });
    expect(storedAction!.status).toBe(actionStatus);
    expect(storedAction!.completedAt).not.toBeNull();
    const storedSlot = await testDb.query.accountPostComments.findFirst({ where: eq(schema.accountPostComments.scheduledActionId, action.id) });
    expect(storedSlot!.status).toBe(actionStatus);
  });

  describe('scanCampaignResume permutations', () => {
    it('scans all ready prospects for tenant when campaignId is omitted', async () => {
      const service = buildService();
      const customTenantId = randomUUID();
      await testDb
        .insert(schema.prospects)
        .values({
          id: randomUUID(),
          tenantId: customTenantId,
          linkedinUrl: `https://linkedin.com/in/prospect-${randomUUID()}`,
          normalizedLinkedinUrl: `https://linkedin.com/in/prospect-${randomUUID()}`,
          currentStage: 'READY_FOR_CAMPAIGN',
        });

      const result = await service.scanCampaignResume(customTenantId);
      expect(result.status).toBe('completed');
      expect(result.prospectsScanned).toBeGreaterThanOrEqual(1);
    });

    it('scans enrolled prospects when both tenantId and campaignId are provided', async () => {
      const service = buildService();
      const customTenantId = randomUUID();
      const campaignId = randomUUID();

      await testDb.insert(schema.campaigns).values({
        id: campaignId,
        tenantId: customTenantId,
        name: 'Permutation Campaign',
        status: 'ACTIVE',
      });

      const [prospect] = await testDb
        .insert(schema.prospects)
        .values({
          id: randomUUID(),
          tenantId: customTenantId,
          linkedinUrl: `https://linkedin.com/in/prospect-${randomUUID()}`,
          normalizedLinkedinUrl: `https://linkedin.com/in/prospect-${randomUUID()}`,
          currentStage: 'READY_FOR_CAMPAIGN',
        })
        .returning();

      await testDb.insert(schema.campaignEnrollments).values({
        id: randomUUID(),
        campaignId,
        prospectId: prospect.id,
        status: 'ACTIVE',
      });

      const result = await service.scanCampaignResume(customTenantId, campaignId);
      expect(result.status).toBe('completed');
      expect(result.prospectsScanned).toBe(1);
    });

    it('scans enrolled prospects when single argument is a campaignId', async () => {
      const service = buildService();
      const customTenantId = randomUUID();
      const campaignId = randomUUID();

      await testDb.insert(schema.campaigns).values({
        id: campaignId,
        tenantId: customTenantId,
        name: 'Single Arg Campaign',
        status: 'ACTIVE',
      });

      const [prospect] = await testDb
        .insert(schema.prospects)
        .values({
          id: randomUUID(),
          tenantId: customTenantId,
          linkedinUrl: `https://linkedin.com/in/prospect-${randomUUID()}`,
          normalizedLinkedinUrl: `https://linkedin.com/in/prospect-${randomUUID()}`,
          currentStage: 'READY_FOR_CAMPAIGN',
        })
        .returning();

      await testDb.insert(schema.campaignEnrollments).values({
        id: randomUUID(),
        campaignId,
        prospectId: prospect.id,
        status: 'ACTIVE',
      });

      const result = await service.scanCampaignResume(campaignId);
      expect(result.status).toBe('completed');
      expect(result.prospectsScanned).toBe(1);
    });

    it('scans all ready prospects for tenant when called with (tenantId, undefined)', async () => {
      const service = buildService();
      const customTenantId = randomUUID();

      await testDb
        .insert(schema.prospects)
        .values({
          id: randomUUID(),
          tenantId: customTenantId,
          linkedinUrl: `https://linkedin.com/in/prospect-${randomUUID()}`,
          normalizedLinkedinUrl: `https://linkedin.com/in/prospect-${randomUUID()}`,
          currentStage: 'READY_FOR_CAMPAIGN',
        });

      const result = await service.scanCampaignResume(customTenantId, undefined);
      expect(result.status).toBe('completed');
      expect(result.prospectsScanned).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('post integrity remediation (no synthetic posts, URL gate)', () => {
  it('requestAction refuses a post with an invalid LinkedIn post URL via POST_NOT_ELIGIBLE and inserts nothing', async () => {
    const postHash = 'd'.repeat(64);
    const invalidPostUrl = 'https://www.linkedin.com/in/prospect-xyz/recent-activity/all/#post-0';
    const { post } = await createProspectWithPost(postHash, invalidPostUrl);
    const draft = await createDraft(post.id, post.prospectId);
    const service = buildService();
    await service.applyReviewDecision({ draftId: draft.id, tenantId: TENANT_ID, decision: 'APPROVED', operatorId: OPERATOR_ID });
    await testDb.insert(schema.engagementControls).values({ tenantId: TENANT_ID, accountId: ACCOUNT_ID, actionType: 'COMMENT', enabled: true }).onConflictDoNothing();
    await testDb.insert(schema.browserAccounts).values({ id: ACCOUNT_ID, tenantId: TENANT_ID, label: 'test', health: 'HEALTHY', sessionExpiresAt: new Date(Date.now() + 60_000) }).onConflictDoNothing();
    const budgetDate = new Date(); budgetDate.setHours(0, 0, 0, 0);
    await testDb.insert(schema.dailyActionBudgets).values({ tenantId: TENANT_ID, accountId: ACCOUNT_ID, actionType: 'COMMENT', budgetDate, limit: 10 }).onConflictDoNothing();

    await expect(service.requestAction({
      draftId: draft.id,
      tenantId: TENANT_ID,
      accountId: ACCOUNT_ID,
      actionType: 'COMMENT',
      mode: 'SIMULATE',
      idempotencyKey: 'invalid-post-url',
    })).rejects.toThrow('POST_NOT_ELIGIBLE');

    // Nothing may enter scheduled_actions for this prospect
    const actions = await testDb.query.scheduledActions.findMany({
      where: eq(schema.scheduledActions.prospectId, post.prospectId),
    });
    expect(actions).toHaveLength(0);
    // No comment slot may be claimed for the invalid post's canonical identity
    const slots = await testDb.query.accountPostComments.findMany({
      where: eq(schema.accountPostComments.canonicalPostIdentifier, post.canonicalPostIdentifier),
    });
    expect(slots).toHaveLength(0);
  });

  it('scanProspect with zero raw posts creates zero drafts and no placeholder post text', async () => {
    const [prospect] = await testDb
      .insert(schema.prospects)
      .values({
        id: randomUUID(),
        tenantId: TENANT_ID,
        linkedinUrl: `https://linkedin.com/in/prospect-${randomUUID()}`,
        normalizedLinkedinUrl: `https://linkedin.com/in/prospect-${randomUUID()}`,
        currentStage: 'READY_FOR_CAMPAIGN',
      })
      .returning();

    const service = new EngagementService({
      postSource: {
        sourceType: 'PLAYWRIGHT',
        findRecentPosts: async () => [],
      },
      aiProvider: {
        providerName: 'fake',
        generateComment: async () => ({ commentText: 'unused', groundingEvidence: 'unused' }),
      },
    });

    const result = await service.scanProspect(TENANT_ID, prospect.id);
    expect(result.postsFound).toBe(0);
    expect(result.draftsCreated).toBe(0);
    expect(result.postsFiltered).toBe(0);

    // No fabricated post rows and no drafts may exist for this prospect
    const posts = await testDb.query.engagementPosts.findMany({
      where: eq(schema.engagementPosts.prospectId, prospect.id),
    });
    expect(posts).toHaveLength(0);
    const drafts = await testDb.query.engagementDrafts.findMany({
      where: eq(schema.engagementDrafts.prospectId, prospect.id),
    });
    expect(drafts).toHaveLength(0);
    // No synthetic #post-N URL may be fabricated for this prospect
    const prospectPosts = await testDb.query.engagementPosts.findMany({
      where: eq(schema.engagementPosts.prospectId, prospect.id),
    });
    expect(prospectPosts.some((p) => p.postUrl.includes('#post-'))).toBe(false);
  });

  it('scanProspect filters out raw posts with invalid LinkedIn post URLs and increments postsFiltered', async () => {
    const [prospect] = await testDb
      .insert(schema.prospects)
      .values({
        id: randomUUID(),
        tenantId: TENANT_ID,
        linkedinUrl: `https://linkedin.com/in/prospect-${randomUUID()}`,
        normalizedLinkedinUrl: `https://linkedin.com/in/prospect-${randomUUID()}`,
        currentStage: 'READY_FOR_CAMPAIGN',
      })
      .returning();

    const service = new EngagementService({
      postSource: {
        sourceType: 'PLAYWRIGHT',
        findRecentPosts: async () => [
          {
            postUrl: 'https://linkedin.com/in/prospect/recent-activity/all/#post-0',
            postText: 'This is a synthetic or invalid post URL',
            authorName: 'Prospect Author',
            publishedAt: new Date(),
          },
          {
            postUrl: 'https://fixture.test/posts/fake-post',
            postText: 'Another post with a non-LinkedIn domain',
            authorName: 'Prospect Author',
            publishedAt: new Date(),
          },
        ],
      },
      aiProvider: {
        providerName: 'fake',
        generateComment: async () => ({ commentText: 'unused', groundingEvidence: 'unused' }),
      },
    });

    const result = await service.scanProspect(TENANT_ID, prospect.id);
    expect(result.postsFound).toBe(2);
    expect(result.postsFiltered).toBe(2);
    expect(result.draftsCreated).toBe(0);

    const posts = await testDb.query.engagementPosts.findMany({
      where: eq(schema.engagementPosts.prospectId, prospect.id),
    });
    expect(posts).toHaveLength(0);
    const drafts = await testDb.query.engagementDrafts.findMany({
      where: eq(schema.engagementDrafts.prospectId, prospect.id),
    });
    expect(drafts).toHaveLength(0);
  });
});
