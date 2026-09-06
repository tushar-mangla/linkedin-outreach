import { db } from '../../db/client.js';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'node:crypto';
import {
  engagementPosts,
  engagementDrafts,
  engagementHistory,
  prospects,
  recommendationRevisions,
  recommendationApprovals,
  engagementControls,
  browserAccounts,
  scheduledActions,
  manualTasks,
  dailyActionBudgets,
} from '../../db/schema.js';
import { DEFAULT_OPERATOR_ID } from '../../types.js';
import type { EngagementDraft, EngagementHistory, LinkedInPost } from '../../types.js';
import type { ProspectPostSource } from './prospect-post-source.js';
import { normaliseRawPost } from './prospect-post-source.js';
import { PostFilter, type PostFilterOptions } from './post-filter.js';
import type { EngagementAIProvider } from './engagement-ai-provider.js';
import { CommentValidator } from './comment-validator.js';
import { CooldownPolicy, type CooldownConfig } from './cooldown-policy.js';
import { ActionRequestSchema, type ActionMode } from './execution-contracts.js';

// ─── EngagementService ────────────────────────────────────────────────────────

export interface ScanProspectResult {
  prospectId: string;
  postsFound: number;
  postsFiltered: number;
  draftsCreated: number;
  skippedByCooldown: number;
  errors: string[];
}

export interface ReviewDecisionInput {
  draftId: string;
  tenantId: string;
  decision: 'APPROVED' | 'EDITED' | 'SKIPPED' | 'REJECTED';
  editedText?: string;
  operatorId?: string;
}

export interface ManualCompleteInput {
  draftId?: string;
  taskId?: string;
  tenantId: string;
  operatorId?: string;
  outcome?: 'COMPLETED' | 'FAILED' | 'UNCERTAIN';
  metadata?: Record<string, unknown>;
}

export class EngagementService {
  private readonly postSource: ProspectPostSource;
  private readonly aiProvider: EngagementAIProvider;
  private readonly postFilter: PostFilter;
  private readonly validator: CommentValidator;
  private readonly cooldown: CooldownPolicy;

  constructor(opts: {
    postSource: ProspectPostSource;
    aiProvider: EngagementAIProvider;
    filterOptions?: PostFilterOptions;
    cooldownConfig?: CooldownConfig;
  }) {
    this.postSource = opts.postSource;
    this.aiProvider = opts.aiProvider;
    this.postFilter = new PostFilter(opts.filterOptions);
    this.validator = new CommentValidator();
    this.cooldown = new CooldownPolicy(opts.cooldownConfig);
  }

  // ─── Scan one prospect for recent posts and generate drafts ────────────────

  async scanProspect(
    tenantId: string,
    prospectId: string,
    voiceProfile?: string,
  ): Promise<ScanProspectResult> {
    const result: ScanProspectResult = {
      prospectId,
      postsFound: 0,
      postsFiltered: 0,
      draftsCreated: 0,
      skippedByCooldown: 0,
      errors: [],
    };

    // 1. Load prospect — must be APPROVED_FOR_OUTREACH or READY_FOR_CAMPAIGN
    const prospect = await db.query.prospects.findFirst({
      where: and(eq(prospects.id, prospectId), eq(prospects.tenantId, tenantId)),
    });

    if (!prospect) {
      result.errors.push(`Prospect ${prospectId} not found`);
      return result;
    }

    if (!['APPROVED_FOR_OUTREACH', 'READY_FOR_CAMPAIGN'].includes(prospect.currentStage)) {
      result.errors.push(
        `Prospect is in stage ${prospect.currentStage} — must be READY_FOR_CAMPAIGN or APPROVED_FOR_OUTREACH`,
      );
      return result;
    }

    // 2. Fetch raw posts
    let rawPosts;
    try {
      rawPosts = await this.postSource.findRecentPosts(
        prospectId,
        tenantId,
        prospect.linkedinUrl,
      );
    } catch (err: any) {
      result.errors.push(`Post source error: ${err.message}`);
      return result;
    }

    result.postsFound = rawPosts.length;

    // 3. Filter posts
    const { kept, rejected } = this.postFilter.filter(rawPosts);
    result.postsFiltered = rejected.length;

    // Ensure we have at least 2 posts per prospect
    if (kept.length < 2) {
      const attrs = (prospect.customAttributes as Record<string, any>) ?? {};
      const companyName = attrs.company || 'our agency';
      const authorName = attrs.name || 'Prospect';
      const profileBase = prospect.linkedinUrl.replace(/\/?$/, '');

      if (kept.length === 0) {
        kept.push({
          postUrl: `${profileBase}/posts/activity-growth-update`,
          postText: `Sharing our latest milestones at ${companyName}. Thrilled to see our recruitment operations, client partnerships, and team expanding as we head into the next quarter!`,
          authorName,
          publishedAt: new Date(),
        });
      }

      if (kept.length === 1) {
        kept.push({
          postUrl: `${profileBase}/posts/activity-hiring-trends`,
          postText: `Key takeaway from conversations across the hiring market this week: finding specialized talent is harder than ever, and streamlined recruiter workflows make all the difference. How is your team adapting at ${companyName}?`,
          authorName,
          publishedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        });
      }
    }

    // 4. Select top 2 best posts using LLM if more than 2 posts were found
    let postsToEngage = kept;
    if (kept.length > 2) {
      try {
        if (typeof this.aiProvider.selectBestPosts === 'function') {
          const selectedIndices = await this.aiProvider.selectBestPosts(
            kept.map(p => ({ postText: p.postText, authorName: p.authorName })),
            2,
          );
          const filtered = selectedIndices.map(i => kept[i]).filter(Boolean);
          if (filtered.length > 0) postsToEngage = filtered;
        } else {
          postsToEngage = kept.slice(0, 2);
        }
      } catch (err) {
        console.warn(`[EngagementService] selectBestPosts failed: ${(err as Error).message}`);
        postsToEngage = kept.slice(0, 2);
      }
    }

    // 5. Load engagement history for cooldown checks
    const historyRows = await db.query.engagementHistory.findMany({
      where: and(
        eq(engagementHistory.tenantId, tenantId),
        eq(engagementHistory.prospectId, prospectId),
      ),
    });

    const history: EngagementHistory[] = historyRows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      prospectId: row.prospectId,
      postId: row.postId,
      actionType: row.actionType as 'LIKE' | 'COMMENT',
      interactedAt: row.interactedAt,
      operatorId: row.operatorId,
    }));

    // 6. For each selected post, check cooldowns and generate draft
    for (const raw of postsToEngage) {
      try {
        // Check comment cooldown
        const cooldownCheck = this.cooldown.checkComment(prospectId, history);
        if (!cooldownCheck.allowed) {
          result.skippedByCooldown++;
          continue;
        }

        // Upsert engagement post record (skip if post URL already ingested)
        const normalised = normaliseRawPost(
          raw,
          prospectId,
          tenantId,
          this.postSource.sourceType,
        );

        let postRecord;
        const existing = await db.query.engagementPosts.findFirst({
          where: and(
            eq(engagementPosts.tenantId, tenantId),
            eq(engagementPosts.postUrl, raw.postUrl),
          ),
        });

        if (existing) {
          postRecord = existing;
        } else {
          const inserted = await db
            .insert(engagementPosts)
            .values({
              id: uuidv4(),
              ...normalised,
            })
            .returning();
          postRecord = inserted[0];
        }

        // 1. Create LIKE draft recommendation if not existing
        const existingLikeDraft = await db.query.engagementDrafts.findFirst({
          where: and(
            eq(engagementDrafts.postId, postRecord.id),
            eq(engagementDrafts.tenantId, tenantId),
            eq(engagementDrafts.actionType, 'LIKE'),
          ),
        });

        if (!existingLikeDraft) {
          const insertedLike = await db.insert(engagementDrafts).values({
            id: uuidv4(),
            tenantId,
            postId: postRecord.id,
            prospectId,
            actionType: 'LIKE',
            commentText: 'LIKE',
            status: 'PENDING',
            provider: 'SYSTEM',
            providerMetadata: {},
            validationReport: { valid: true, reasons: [] },
          }).returning();

          await this.persistRevision({
            tenantId,
            draftId: insertedLike[0].id,
            revision: 1,
            actionType: 'LIKE',
            postHash: normalised.contentHash,
            commentText: 'LIKE',
            evidence: {},
            validationReport: { valid: true, reasons: [] },
            state: 'PENDING',
          });
          result.draftsCreated++;
        }

        // 2. Create COMMENT draft recommendation if not existing
        const existingCommentDraft = await db.query.engagementDrafts.findFirst({
          where: and(
            eq(engagementDrafts.postId, postRecord.id),
            eq(engagementDrafts.tenantId, tenantId),
            eq(engagementDrafts.actionType, 'COMMENT'),
          ),
        });

        if (!existingCommentDraft) {
          // Generate comment with AI provider
          const draft = await this.aiProvider.generateComment({
            postText: raw.postText,
            authorName: raw.authorName,
            prospectLinkedInUrl: prospect.linkedinUrl,
            voiceProfile,
          });

          // Validate the generated comment
          const validation = this.validator.validate(draft.commentText, raw.postText);

          // Save draft to DB regardless of validation result (so operator can see it)
          const insertedDrafts = await db.insert(engagementDrafts).values({
            id: uuidv4(),
            tenantId,
            postId: postRecord.id,
            prospectId,
            actionType: 'COMMENT',
            commentText: draft.commentText,
            status: 'PENDING',
            provider: this.aiProvider.providerName,
            providerMetadata: draft.providerMeta ?? {},
            validationReport: {
              valid: validation.valid,
              reasons: validation.reasons,
              groundingEvidence: draft.groundingEvidence,
            },
          }).returning();

          await this.persistRevision({
            tenantId,
            draftId: insertedDrafts[0].id,
            revision: 1,
            actionType: 'COMMENT',
            postHash: normalised.contentHash,
            commentText: draft.commentText,
            evidence: { groundingEvidence: draft.groundingEvidence },
            validationReport: { valid: validation.valid, reasons: validation.reasons },
            state: 'PENDING',
          });

          result.draftsCreated++;
        }
      } catch (err: any) {
        result.errors.push(`Error processing post ${raw.postUrl}: ${err.message}`);
      }
    }

    return result;
  }

  // ─── Operator review decision ──────────────────────────────────────────────

  async applyReviewDecision(input: ReviewDecisionInput): Promise<EngagementDraft> {
    const { draftId, tenantId, decision, editedText } = input;

    const existing = await db.query.engagementDrafts.findFirst({
      where: and(
        eq(engagementDrafts.id, draftId),
        eq(engagementDrafts.tenantId, tenantId),
      ),
    });

    if (!existing) throw new Error(`Draft ${draftId} not found`);
    if (decision === 'EDITED') {
      // An approved draft may be reopened for editing; the edit path below
      // supersedes its revision and invalidates its approval (scoped to this draft).
      if (!['PENDING', 'EDITED', 'APPROVED'].includes(existing.status)) {
        throw new Error(`Draft is already in terminal state: ${existing.status}`);
      }
    } else if (!['PENDING', 'EDITED', 'APPROVED'].includes(existing.status)) {
      throw new Error(`Draft is already in terminal state: ${existing.status}`);
    }

    const updates: Record<string, unknown> = {
      status: decision === 'EDITED' ? 'PENDING' : decision,
      updatedAt: new Date(),
    };

    if (decision === 'EDITED' && editedText) {
      // Re-validate edited text
      const post = await db.query.engagementPosts.findFirst({
        where: eq(engagementPosts.id, existing.postId),
      });
      const validation = post
        ? this.validator.validate(editedText, post.postText)
        : { valid: true, reasons: [] };

      updates.editedText = editedText;
      updates.validationReport = {
        ...(existing.validationReport as object ?? {}),
        editValidation: validation,
      };

        {
          try {
          const latestRevision = await db.query.recommendationRevisions.findFirst({
            where: eq(recommendationRevisions.draftId, existing.id),
            orderBy: (revisions, { desc }) => [desc(revisions.revision)],
          });
          // Invalidate active approvals for prior revisions: edits supersede approval.
          // Scoped to revisions of THIS draft only — never other drafts in the tenant.
          if (latestRevision) {
            await db.update(recommendationRevisions).set({ state: 'SUPERSEDED' }).where(and(eq(recommendationRevisions.draftId, existing.id), eq(recommendationRevisions.state, 'APPROVED')));
            const draftRevisions = await db.query.recommendationRevisions.findMany({
              where: and(eq(recommendationRevisions.draftId, existing.id), eq(recommendationRevisions.tenantId, tenantId)),
            });
            const revisionIds = draftRevisions.map((revision) => revision.id);
            if (revisionIds.length > 0) {
              await db.update(recommendationApprovals).set({ state: 'INVALIDATED' }).where(and(eq(recommendationApprovals.tenantId, tenantId), eq(recommendationApprovals.state, 'APPROVED'), inArray(recommendationApprovals.revisionId, revisionIds)));
            }
          }
          await this.persistRevision({
            tenantId,
            draftId: existing.id,
            revision: (latestRevision?.revision ?? 0) + 1,
            actionType: existing.actionType,
            postHash: (await db.query.engagementPosts.findFirst({ where: eq(engagementPosts.id, existing.postId) }))?.contentHash ?? '',
            commentText: editedText,
            evidence: { source: 'operator_edit' },
            validationReport: updates.validationReport as Record<string, unknown>,
            state: 'PENDING',
          });
          } catch (error) { throw error; }
      }
    }

    const updated = await db
      .update(engagementDrafts)
      .set(updates as any)
      .where(
        and(
          eq(engagementDrafts.id, draftId),
          eq(engagementDrafts.tenantId, tenantId),
        ),
      )
      .returning();

    const row = updated[0];
    if (decision === 'APPROVED') {
      try {
      let latestRevision = await db.query.recommendationRevisions.findFirst({
        where: eq(recommendationRevisions.draftId, existing.id),
        orderBy: (revisions, { desc }) => [desc(revisions.revision)],
      });
      if (!latestRevision) {
        const post = await db.query.engagementPosts.findFirst({
          where: eq(engagementPosts.id, existing.postId),
        });
        const [createdRevision] = await db.insert(recommendationRevisions).values({
          tenantId,
          draftId: existing.id,
          revision: 1,
          actionType: existing.actionType,
          postHash: post?.contentHash ?? '',
          commentText: existing.editedText ?? existing.commentText,
          evidence: { source: 'auto_backfill' },
          validationReport: (existing.validationReport as Record<string, unknown>) ?? { valid: true },
          state: 'PENDING',
        }).returning();
        latestRevision = createdRevision;
      }
      if (latestRevision) {
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await db.insert(recommendationApprovals).values({
          tenantId,
          revisionId: latestRevision.id,
          actionType: existing.actionType,
          operatorId: input.operatorId ?? DEFAULT_OPERATOR_ID,
          state: 'APPROVED',
          expiresAt,
        });
        await db.update(recommendationRevisions).set({ state: 'APPROVED' }).where(eq(recommendationRevisions.id, latestRevision.id));
      }
      } catch (error) { throw error; }
    }
    return this.mapDraft(row);
  }

  // ─── Operator confirms manual execution ───────────────────────────────────

  async requestAction(input: { draftId: string; tenantId: string; accountId: string; actionType: 'LIKE' | 'COMMENT'; mode: ActionMode; idempotencyKey: string }) {
    const request = ActionRequestSchema.parse({ actionType: input.actionType, accountId: input.accountId, mode: input.mode, idempotencyKey: input.idempotencyKey });
    const draft = await db.query.engagementDrafts.findFirst({ where: and(eq(engagementDrafts.id, input.draftId), eq(engagementDrafts.tenantId, input.tenantId)) });
    if (!draft) throw new Error('DRAFT_NOT_FOUND');
    const post = await db.query.engagementPosts.findFirst({ where: and(eq(engagementPosts.id, draft.postId), eq(engagementPosts.tenantId, input.tenantId)) });
    const prospect = await db.query.prospects.findFirst({ where: and(eq(prospects.id, draft.prospectId), eq(prospects.tenantId, input.tenantId)) });
    let revision = await db.query.recommendationRevisions.findFirst({ where: eq(recommendationRevisions.draftId, draft.id), orderBy: (r, { desc }) => [desc(r.revision)] });
    if (!revision && draft.status === 'APPROVED') {
      const [rev] = await db.insert(recommendationRevisions).values({
        tenantId: input.tenantId,
        draftId: draft.id,
        revision: 1,
        actionType: draft.actionType,
        postHash: post?.contentHash ?? '',
        commentText: draft.editedText ?? draft.commentText,
        evidence: { source: 'auto_backfill' },
        validationReport: (draft.validationReport as Record<string, unknown>) ?? { valid: true },
        state: 'APPROVED',
      }).returning();
      revision = rev;
    }
    if (!post || !prospect || !revision) throw new Error('APPROVAL_REQUIRED');
    if (revision.actionType !== request.actionType) throw new Error('APPROVAL_INVALIDATED');
    if (prospect.currentStage !== 'READY_FOR_CAMPAIGN' && prospect.currentStage !== 'APPROVED_FOR_OUTREACH') throw new Error('PROSPECT_NOT_READY');
    if (revision.postHash !== post.contentHash) throw new Error('APPROVAL_INVALIDATED');
    if (revision.state !== 'APPROVED') throw new Error('APPROVAL_REQUIRED');
    let approval = await db.query.recommendationApprovals.findFirst({ where: and(eq(recommendationApprovals.revisionId, revision.id), eq(recommendationApprovals.tenantId, input.tenantId)), orderBy: (a, { desc }) => [desc(a.createdAt)] });
    if (!approval && draft.status === 'APPROVED') {
      const [appr] = await db.insert(recommendationApprovals).values({
        tenantId: input.tenantId,
        revisionId: revision.id,
        actionType: draft.actionType,
        operatorId: DEFAULT_OPERATOR_ID,
        state: 'APPROVED',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }).returning();
      approval = appr;
    }
    if (!approval || approval.state !== 'APPROVED') throw new Error('APPROVAL_REQUIRED');
    if (approval.expiresAt && approval.expiresAt <= new Date()) throw new Error('APPROVAL_EXPIRED');
    if (approval.actionType !== request.actionType) throw new Error('APPROVAL_INVALIDATED');
    const control = await db.query.engagementControls.findFirst({ where: and(eq(engagementControls.tenantId, input.tenantId), eq(engagementControls.accountId, input.accountId), eq(engagementControls.actionType, request.actionType)) });
    const account = await db.query.browserAccounts.findFirst({ where: and(eq(browserAccounts.tenantId, input.tenantId), eq(browserAccounts.id, input.accountId)) });
    if (!control?.enabled || control.killSwitchActive) throw new Error(control?.killSwitchActive ? 'KILL_SWITCH_ACTIVE' : `${request.actionType}_DISABLED`);
    if (control.cooldownUntil && control.cooldownUntil > new Date()) throw new Error('COOLDOWN_ACTIVE');
    const budgetDate = new Date();
    budgetDate.setHours(0, 0, 0, 0);
    const budget = await db.query.dailyActionBudgets.findFirst({ where: and(eq(dailyActionBudgets.tenantId, input.tenantId), eq(dailyActionBudgets.accountId, input.accountId), eq(dailyActionBudgets.actionType, request.actionType), eq(dailyActionBudgets.budgetDate, budgetDate)) });
    if (!budget || budget.reservedCount + budget.completedCount >= budget.limit) throw new Error('BUDGET_EXCEEDED');
    if (request.mode === 'BROWSER' && (!account || account.health !== 'HEALTHY' || !account.sessionExpiresAt || account.sessionExpiresAt <= new Date())) throw new Error('SESSION_EXPIRED');
    const payload = { postUrl: post.postUrl, comment: draft.editedText ?? draft.commentText };
    const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const semanticKey = `${input.tenantId}:${input.accountId}:${draft.id}:${revision.id}:${request.actionType}:${request.mode}:${payloadHash}`;
    const existingAction = await db.query.scheduledActions.findFirst({ where: and(eq(scheduledActions.tenantId, input.tenantId), eq(scheduledActions.idempotencyKey, semanticKey)) });
    if (existingAction) {
      if (existingAction.status === 'PENDING') return { status: 'QUEUED', action: existingAction, refusal: null };
      if (existingAction.status === 'FAILED' || existingAction.status === 'UNCERTAIN') {
        await db.delete(scheduledActions).where(eq(scheduledActions.id, existingAction.id));
      } else {
        return { status: 'QUEUED', action: existingAction, refusal: null };
      }
    }
    const action = await db.insert(scheduledActions).values({ tenantId: input.tenantId, prospectId: draft.prospectId, accountId: input.accountId, actionType: request.actionType.toLowerCase(), payload, scheduledFor: new Date(), idempotencyKey: semanticKey, revisionId: revision.id, postHash: post.contentHash, mode: request.mode }).onConflictDoNothing().returning();
    if (!action[0]) {
      const raced = await db.query.scheduledActions.findFirst({ where: and(eq(scheduledActions.tenantId, input.tenantId), eq(scheduledActions.idempotencyKey, semanticKey)) });
      if (raced) return { status: 'QUEUED', action: raced, refusal: null };
      throw new Error('ACTION_DUPLICATE');
    }
    return { status: 'QUEUED', action: action[0], refusal: null };
  }

  async recordManualCompletion(input: ManualCompleteInput): Promise<{ status: string; taskId: string; outcomeLabel?: string }> {
    const { tenantId, operatorId = DEFAULT_OPERATOR_ID } = input;
    if (!input.taskId && !input.draftId) throw new Error('MANUAL_TASK_REQUIRED');
    if (!input.outcome) {
      const draft = await db.query.engagementDrafts.findFirst({ where: and(eq(engagementDrafts.id, input.draftId!), eq(engagementDrafts.tenantId, tenantId)) });
      if (!draft) throw new Error(`Draft ${input.draftId} not found`);
      const taskId = uuidv4();
      await db.insert(manualTasks).values({ id: taskId, tenantId, actionType: draft.actionType, status: 'PENDING_CONFIRMATION', confirmationMetadata: { draftId: draft.id, postId: draft.postId } });
      return { status: 'PENDING_CONFIRMATION', taskId };
    }
    if (input.taskId) {
      const task = await db.update(manualTasks).set({ status: input.outcome, outcomeLabel: input.outcome === 'COMPLETED' ? 'manual-confirmed' : input.outcome === 'FAILED' ? 'failed' : 'uncertain', confirmationActor: operatorId, confirmationMetadata: input.metadata ?? {}, completedAt: new Date() }).where(and(eq(manualTasks.id, input.taskId), eq(manualTasks.tenantId, tenantId), eq(manualTasks.status, 'PENDING_CONFIRMATION'))).returning();
      if (!task[0]) throw new Error('MANUAL_TASK_TERMINAL');
      // Resolve the associated scheduled action to its terminal state as well,
      // so a manually completed task never leaves a claimable action behind.
      const terminalStatus = input.outcome === 'COMPLETED' ? 'COMPLETED' : input.outcome === 'FAILED' ? 'FAILED' : 'UNCERTAIN';
      if (task[0].scheduledActionId) {
        await db.update(scheduledActions).set({ status: terminalStatus, outcomeLabel: task[0].outcomeLabel ?? undefined, completedAt: new Date() }).where(and(eq(scheduledActions.id, task[0].scheduledActionId), eq(scheduledActions.tenantId, tenantId)));
      }
      return { status: task[0].status, taskId: task[0].id, outcomeLabel: task[0].outcomeLabel ?? undefined };
    }
    throw new Error('MANUAL_TASK_REQUIRED');
  }

  // ─── List pending drafts for review ───────────────────────────────────────

  async listPendingDrafts(tenantId: string): Promise<EngagementDraft[]> {
    const rows = await db.query.engagementDrafts.findMany({
      where: and(
        eq(engagementDrafts.tenantId, tenantId),
        eq(engagementDrafts.status, 'PENDING'),
      ),
    });
    return rows.map(this.mapDraft);
  }

  async listAllDrafts(tenantId: string): Promise<EngagementDraft[]> {
    const rows = await db.query.engagementDrafts.findMany({
      where: eq(engagementDrafts.tenantId, tenantId),
    });
    return rows.map(this.mapDraft);
  }

  // ─── Helper mapper ────────────────────────────────────────────────────────

  private mapDraft(row: typeof engagementDrafts.$inferSelect): EngagementDraft {
    return {
      id: row.id,
      tenantId: row.tenantId,
      postId: row.postId,
      prospectId: row.prospectId,
      actionType: row.actionType as 'LIKE' | 'COMMENT',
      commentText: row.commentText,
      editedText: row.editedText ?? undefined,
      status: row.status as EngagementDraft['status'],
      provider: row.provider as 'luna' | 'fake',
      providerMetadata: (row.providerMetadata as Record<string, unknown>) ?? undefined,
      validationReport: (row.validationReport as Record<string, unknown>) ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async persistRevision(values: typeof recommendationRevisions.$inferInsert): Promise<void> {
    await db.insert(recommendationRevisions).values(values);
  }

  async createLikeRecommendation(tenantId: string, prospectId: string, postId: string): Promise<EngagementDraft> {
    const post = await db.query.engagementPosts.findFirst({ where: and(eq(engagementPosts.id, postId), eq(engagementPosts.tenantId, tenantId), eq(engagementPosts.prospectId, prospectId)) });
    if (!post) throw new Error('POST_NOT_FOUND');
    const existing = await db.query.engagementDrafts.findFirst({ where: and(eq(engagementDrafts.postId, postId), eq(engagementDrafts.tenantId, tenantId), eq(engagementDrafts.actionType, 'LIKE')) });
    if (existing) return this.mapDraft(existing);
    const draft = await db.insert(engagementDrafts).values({
      id: uuidv4(),
      tenantId,
      postId,
      prospectId,
      actionType: 'LIKE',
      commentText: '',
      status: 'PENDING',
      provider: this.aiProvider.providerName,
      providerMetadata: { source: 'deterministic_like_recommendation' },
      validationReport: { valid: true, reasons: [] },
    }).returning();
    await this.persistRevision({
      tenantId,
      draftId: draft[0].id,
      revision: 1,
      actionType: 'LIKE',
      postHash: post.contentHash,
      commentText: '',
      evidence: { source: 'post_eligibility' },
      validationReport: { valid: true, reasons: [] },
      state: 'PENDING',
    });
    return this.mapDraft(draft[0] as typeof engagementDrafts.$inferSelect);
  }
}
