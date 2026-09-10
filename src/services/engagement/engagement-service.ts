import { db, type DbClient } from '../../db/client.js';
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
  campaignEnrollments,
  accountPostComments,
  campaigns,
} from '../../db/schema.js';
import { withDbRetry, isTransientDbError } from '../../db/retry.js';
import { DEFAULT_OPERATOR_ID } from '../../types.js';

import type { EngagementDraft, EngagementHistory, LinkedInPost, CommentDraft } from '../../types.js';
import type { ProspectPostSource } from './prospect-post-source.js';
import { normaliseRawPost, type RawPost } from './prospect-post-source.js';

import { canonicalPostIdentifier } from './post-identity.js';
import { PostFilter, type PostFilterOptions } from './post-filter.js';
import type { EngagementAIProvider } from './engagement-ai-provider.js';
import { CommentValidator } from './comment-validator.js';
import { CooldownPolicy, type CooldownConfig } from './cooldown-policy.js';
import { ActionRequestSchema, type ActionMode } from './execution-contracts.js';

// ─── EngagementService ────────────────────────────────────────────────────────

function isTransientLLMError(err: unknown): boolean {
  if (!err) return false;
  if (isTransientDbError(err)) return true;
  const anyErr = err as Record<string, unknown>;
  const status = Number(anyErr.status ?? anyErr.statusCode ?? 0);
  if (status >= 500 || status === 429) return true;
  if (status >= 400 && status < 500) return false;

  const code = typeof anyErr.code === 'string' ? anyErr.code.toUpperCase() : '';
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return true;
  }

  const message = typeof anyErr.message === 'string' ? anyErr.message.toLowerCase() : '';
  return (
    message.includes('timeout') ||
    message.includes('socket hang up') ||
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('service unavailable') ||
    message.includes('gateway') ||
    message.includes('temporarily unavailable')
  );
}

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
  private readonly db: DbClient;

  constructor(opts: {
    postSource: ProspectPostSource;
    aiProvider: EngagementAIProvider;
    filterOptions?: PostFilterOptions;
    cooldownConfig?: CooldownConfig;
    db?: DbClient;
  }) {
    this.postSource = opts.postSource;
    this.aiProvider = opts.aiProvider;
    this.postFilter = new PostFilter(opts.filterOptions);
    this.validator = new CommentValidator();
    this.cooldown = new CooldownPolicy(opts.cooldownConfig);
    this.db = opts.db ?? db;
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
    const prospect = await this.db.query.prospects.findFirst({
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

    // 3. Count existing active comment candidates across the prospect
    // to enforce max 1 active comment candidate per prospect at one time.
    const existingActiveDrafts = await this.db.query.engagementDrafts.findMany({
      where: and(
        eq(engagementDrafts.tenantId, tenantId),
        eq(engagementDrafts.prospectId, prospectId),
        eq(engagementDrafts.actionType, 'COMMENT'),
        inArray(engagementDrafts.status, ['PENDING', 'APPROVED']),
      ),
    });

    const existingActiveActions = await this.db.query.scheduledActions.findMany({
      where: and(
        eq(scheduledActions.tenantId, tenantId),
        eq(scheduledActions.prospectId, prospectId),
        eq(scheduledActions.actionType, 'comment'),
        inArray(scheduledActions.status, ['PENDING', 'CLAIMED']),
      ),
    });

    const prospectPosts = await this.db.query.engagementPosts.findMany({
      where: and(
        eq(engagementPosts.tenantId, tenantId),
        eq(engagementPosts.prospectId, prospectId),
      ),
    });

    const activeCandidateKeys = new Set<string>();
    for (const d of existingActiveDrafts) {
      activeCandidateKeys.add(`draft:${d.postId}`);
    }
    for (const a of existingActiveActions) {
      activeCandidateKeys.add(`action:${a.postHash || a.id}`);
    }
    for (const p of prospectPosts) {
      if (activeCandidateKeys.has(`draft:${p.id}`) || activeCandidateKeys.has(`action:${p.contentHash}`)) {
        continue;
      }
      const activeSlot = await this.db.query.accountPostComments.findFirst({
        where: and(
          eq(accountPostComments.tenantId, tenantId),
          eq(accountPostComments.canonicalPostIdentifier, p.canonicalPostIdentifier),
          eq(accountPostComments.status, 'PENDING'),
        ),
      });
      if (activeSlot) {
        activeCandidateKeys.add(`slot:${p.canonicalPostIdentifier}`);
      }
    }

    const currentActiveCandidates = activeCandidateKeys.size;
    const maxNewPostsAllowed = Math.max(0, 1 - currentActiveCandidates);
    if (maxNewPostsAllowed === 0) {
      return result;
    }

    // Filter out raw posts that already have a comment slot with status PENDING, COMPLETED, or UNCERTAIN
    const eligibleRawPosts: typeof rawPosts = [];
    for (const rp of rawPosts) {
      const canonicalId = canonicalPostIdentifier(rp.postUrl);
      const existingSlot = await this.db.query.accountPostComments.findFirst({
        where: and(
          eq(accountPostComments.tenantId, tenantId),
          eq(accountPostComments.canonicalPostIdentifier, canonicalId),
          inArray(accountPostComments.status, ['PENDING', 'COMPLETED', 'UNCERTAIN']),
        ),
      });
      if (existingSlot) {
        // Skip post immediately ("leave it for now")
        continue;
      }
      eligibleRawPosts.push(rp);
    }

    // 4. Filter posts
    const { kept, rejected } = this.postFilter.filter(eligibleRawPosts);
    result.postsFiltered = rejected.length;

    // Ensure we have at least 1 post per prospect (if available)
    if (kept.length < maxNewPostsAllowed) {
      // If post filter rejected them, fallback to using eligible raw posts first
      if (eligibleRawPosts.length > 0) {
        for (const rp of eligibleRawPosts) {
          if (kept.length >= maxNewPostsAllowed) break;
          if (!kept.includes(rp)) kept.push(rp);
        }
      }

      const attrs = (prospect.customAttributes as Record<string, any>) ?? {};
      const companyName = attrs.company || 'our agency';
      const authorName = attrs.name || 'Prospect';
      const profileBase = prospect.linkedinUrl.replace(/\/?$/, '');

      if (rawPosts.length === 0) {
        if (kept.length === 0 && maxNewPostsAllowed >= 1) {
          kept.push({
            postUrl: `${profileBase}/recent-activity/all/#post-0`,
            postText: `Sharing our latest milestones at ${companyName}. Thrilled to see our recruitment operations, client partnerships, and team expanding as we head into the next quarter!`,
            authorName,
            publishedAt: new Date(),
          });
        }
      }
    }

    // 5. Select top best posts using LLM if more than maxNewPostsAllowed posts were found
    let postsToEngage = kept;
    if (kept.length > maxNewPostsAllowed) {
      try {
        if (typeof this.aiProvider.selectBestPosts === 'function') {
          const selectedIndices = await this.aiProvider.selectBestPosts(
            kept.map(p => ({ postText: p.postText, authorName: p.authorName })),
            maxNewPostsAllowed,
          );
          const filtered = selectedIndices.map(i => kept[i]).filter(Boolean);
          if (filtered.length > 0) postsToEngage = filtered;
        } else {
          postsToEngage = kept.slice(0, maxNewPostsAllowed);
        }
      } catch (err) {
        console.warn(`[EngagementService] selectBestPosts failed: ${(err as Error).message}`);
        postsToEngage = kept.slice(0, maxNewPostsAllowed);
      }
    }
    // The selection provider is advisory; persist at most maxNewPostsAllowed distinct posts.
    postsToEngage = postsToEngage
      .filter((post, index, list) => list.findIndex((candidate) => normaliseRawPost(candidate, prospectId, tenantId, this.postSource.sourceType).canonicalPostIdentifier === normaliseRawPost(post, prospectId, tenantId, this.postSource.sourceType).canonicalPostIdentifier) === index)
      .slice(0, maxNewPostsAllowed);

    // 5. Load engagement history for cooldown checks
    const historyRows = await this.db.query.engagementHistory.findMany({
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

        const postResult = await this.processPost(tenantId, prospect, raw, voiceProfile);
        result.draftsCreated += postResult.draftsCreated;
        if (postResult.errors.length > 0) {
          result.errors.push(...postResult.errors);
        }
      } catch (err: any) {
        result.errors.push(`Error processing post ${raw.postUrl}: ${err.message}`);
      }
    }

    return result;
  }

  private async generateCommentWithRetry(input: Parameters<EngagementAIProvider['generateComment']>[0]) {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.aiProvider.generateComment(input);
      } catch (err: any) {
        if (attempt >= maxAttempts || !isTransientLLMError(err)) {
          throw err;
        }
        console.warn(`[EngagementService] generateComment attempt ${attempt} failed with transient error (${err.message}). Retrying...`);
        await new Promise((res) => setTimeout(res, 500 + Math.random() * 250));
      }
    }
    throw new Error('generateComment exhausted attempts');
  }

  private async processPost(
    tenantId: string,
    prospect: typeof prospects.$inferSelect,
    raw: RawPost,
    voiceProfile?: string,
  ): Promise<{ draftsCreated: number; errors: string[] }> {
    let draftsCreated = 0;
    const errors: string[] = [];

    const normalised = normaliseRawPost(
      raw,
      prospect.id,
      tenantId,
      this.postSource.sourceType,
    );

    const existingSlot = await this.db.query.accountPostComments.findFirst({
      where: and(
        eq(accountPostComments.tenantId, tenantId),
        eq(accountPostComments.canonicalPostIdentifier, normalised.canonicalPostIdentifier),
        inArray(accountPostComments.status, ['PENDING', 'COMPLETED', 'UNCERTAIN']),
      ),
    });
    if (existingSlot) {
      return { draftsCreated: 0, errors: [] };
    }

    // Phase 1: Post upsert + LIKE draft + revision (wrapped in withDbRetry)
    let postRecord: typeof engagementPosts.$inferSelect;
    let likeDraft: typeof engagementDrafts.$inferSelect | undefined;

    try {
      const phase1Result = await withDbRetry(async () => {
        return await this.db.transaction(async (tx) => {
          let post = await tx.query.engagementPosts.findFirst({
            where: and(
              eq(engagementPosts.tenantId, tenantId),
              eq(engagementPosts.canonicalPostIdentifier, normalised.canonicalPostIdentifier),
            ),
          });

          if (!post) {
            const inserted = await tx
              .insert(engagementPosts)
              .values({
                id: uuidv4(),
                ...normalised,
              })
              .returning();
            post = inserted[0];
          }

          let like = await tx.query.engagementDrafts.findFirst({
            where: and(
              eq(engagementDrafts.postId, post.id),
              eq(engagementDrafts.tenantId, tenantId),
              eq(engagementDrafts.actionType, 'LIKE'),
            ),
          });

          let likeCreated = false;
          if (!like) {
            const insertedLike = await tx.insert(engagementDrafts).values({
              id: uuidv4(),
              tenantId,
              postId: post.id,
              prospectId: prospect.id,
              actionType: 'LIKE',
              commentText: 'LIKE',
              status: 'PENDING',
              provider: 'SYSTEM',
              providerMetadata: {},
              validationReport: { valid: true, reasons: [] },
            }).returning();
            like = insertedLike[0];

            await this.persistRevision({
              tenantId,
              draftId: like.id,
              revision: 1,
              actionType: 'LIKE',
              postHash: normalised.contentHash,
              commentText: 'LIKE',
              evidence: {},
              validationReport: { valid: true, reasons: [] },
              state: 'PENDING',
            }, tx);
            likeCreated = true;
          }

          return { post, like, likeCreated };
        });
      });

      postRecord = phase1Result.post;
      likeDraft = phase1Result.like;
      if (phase1Result.likeCreated) {
        draftsCreated++;
      }
    } catch (phase1Err: any) {
      errors.push(`Error in Phase 1 for post ${raw.postUrl}: ${phase1Err.message}`);
      return { draftsCreated, errors };
    }

    // Phase 2: Check if COMMENT draft already exists before calling AI
    const existingComment = await withDbRetry(async () => {
      return await this.db.query.engagementDrafts.findFirst({
        where: and(
          eq(engagementDrafts.postId, postRecord.id),
          eq(engagementDrafts.tenantId, tenantId),
          eq(engagementDrafts.actionType, 'COMMENT'),
        ),
      });
    });

    if (existingComment) {
      return { draftsCreated, errors };
    }

    // Phase 2: LLM call outside DB transaction with bounded retry (2 attempts)
    let aiDraft: CommentDraft | undefined;
    try {
      aiDraft = await this.generateCommentWithRetry({
        postText: raw.postText,
        authorName: raw.authorName,
        prospectLinkedInUrl: prospect.linkedinUrl,
        voiceProfile,
      });
    } catch (llmErr: any) {
      console.log(`[Engagement] Comment generation failed for post ${postRecord.id}; LIKE draft ${likeDraft?.id ?? 'existing'} preserved as checkpoint. Catchup worker will backfill.`);
      errors.push(`Error generating comment for post ${raw.postUrl}: ${llmErr.message}`);
      return { draftsCreated, errors };
    }

    if (!aiDraft) {
      return { draftsCreated, errors };
    }

    // Phase 3: Wait to recover DB (withDbRetry) -> check existingCommentDraft -> write COMMENT draft + revision
    try {
      const validation = this.validator.validate(aiDraft.commentText, raw.postText);

      const commentCreated = await withDbRetry(async () => {
        return await this.db.transaction(async (tx) => {
          const checkAgain = await tx.query.engagementDrafts.findFirst({
            where: and(
              eq(engagementDrafts.postId, postRecord.id),
              eq(engagementDrafts.tenantId, tenantId),
              eq(engagementDrafts.actionType, 'COMMENT'),
            ),
          });
          if (checkAgain) return false;

          const insertedDrafts = await tx.insert(engagementDrafts).values({
            id: uuidv4(),
            tenantId,
            postId: postRecord.id,
            prospectId: prospect.id,
            actionType: 'COMMENT',
            commentText: aiDraft!.commentText,
            status: 'PENDING',
            provider: this.aiProvider.providerName,
            providerMetadata: aiDraft!.providerMeta ?? {},
            validationReport: {
              valid: validation.valid,
              reasons: validation.reasons,
              groundingEvidence: aiDraft!.groundingEvidence,
            },
          }).returning();

          await this.persistRevision({
            tenantId,
            draftId: insertedDrafts[0].id,
            revision: 1,
            actionType: 'COMMENT',
            postHash: normalised.contentHash,
            commentText: aiDraft!.commentText,
            evidence: { groundingEvidence: aiDraft!.groundingEvidence },
            validationReport: { valid: validation.valid, reasons: validation.reasons },
            state: 'PENDING',
          }, tx);

          return true;
        });
      });

      if (commentCreated) {
        draftsCreated++;
      }
    } catch (phase3Err: any) {
      console.log(`[Engagement] Comment generation failed for post ${postRecord.id}; LIKE draft ${likeDraft?.id ?? 'existing'} preserved as checkpoint. Catchup worker will backfill.`);
      errors.push(`Error processing post ${raw.postUrl}: ${phase3Err.message}`);
    }

    return { draftsCreated, errors };
  }

  // ─── Operator review decision ──────────────────────────────────────────────

  async applyReviewDecision(input: ReviewDecisionInput): Promise<EngagementDraft> {
    const { draftId, tenantId, decision, editedText } = input;

    const existing = await this.db.query.engagementDrafts.findFirst({
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
      const post = await this.db.query.engagementPosts.findFirst({
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
          const latestRevision = await this.db.query.recommendationRevisions.findFirst({
            where: eq(recommendationRevisions.draftId, existing.id),
            orderBy: (revisions, { desc }) => [desc(revisions.revision)],
          });
          // Invalidate active approvals for prior revisions: edits supersede approval.
          // Scoped to revisions of THIS draft only — never other drafts in the tenant.
          if (latestRevision) {
            await this.db.update(recommendationRevisions).set({ state: 'SUPERSEDED' }).where(and(eq(recommendationRevisions.draftId, existing.id), eq(recommendationRevisions.state, 'APPROVED')));
            const draftRevisions = await this.db.query.recommendationRevisions.findMany({
              where: and(eq(recommendationRevisions.draftId, existing.id), eq(recommendationRevisions.tenantId, tenantId)),
            });
            const revisionIds = draftRevisions.map((revision) => revision.id);
            if (revisionIds.length > 0) {
              await this.db.update(recommendationApprovals).set({ state: 'INVALIDATED' }).where(and(eq(recommendationApprovals.tenantId, tenantId), eq(recommendationApprovals.state, 'APPROVED'), inArray(recommendationApprovals.revisionId, revisionIds)));
            }
          }
          await this.persistRevision({
            tenantId,
            draftId: existing.id,
            revision: (latestRevision?.revision ?? 0) + 1,
            actionType: existing.actionType,
            postHash: (await this.db.query.engagementPosts.findFirst({ where: eq(engagementPosts.id, existing.postId) }))?.contentHash ?? '',
            commentText: editedText,
            evidence: { source: 'operator_edit' },
            validationReport: updates.validationReport as Record<string, unknown>,
            state: 'PENDING',
          });
          } catch (error) { throw error; }
      }
    }

    const updated = await this.db
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
      let latestRevision = await this.db.query.recommendationRevisions.findFirst({
        where: eq(recommendationRevisions.draftId, existing.id),
        orderBy: (revisions, { desc }) => [desc(revisions.revision)],
      });
      if (!latestRevision) {
        const post = await this.db.query.engagementPosts.findFirst({
          where: eq(engagementPosts.id, existing.postId),
        });
        const [createdRevision] = await this.db.insert(recommendationRevisions).values({
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
        await this.db.insert(recommendationApprovals).values({
          tenantId,
          revisionId: latestRevision.id,
          actionType: existing.actionType,
          operatorId: input.operatorId ?? DEFAULT_OPERATOR_ID,
          state: 'APPROVED',
          expiresAt,
        });
        await this.db.update(recommendationRevisions).set({ state: 'APPROVED' }).where(eq(recommendationRevisions.id, latestRevision.id));
      }
      } catch (error) { throw error; }
    }
    return this.mapDraft(row);
  }

  // ─── Operator confirms manual execution ───────────────────────────────────

  async requestAction(input: { draftId: string; tenantId: string; accountId: string; actionType: 'LIKE' | 'COMMENT'; mode: ActionMode; idempotencyKey: string }) {
    const request = ActionRequestSchema.parse({ actionType: input.actionType, accountId: input.accountId, mode: input.mode, idempotencyKey: input.idempotencyKey });
    const draft = await this.db.query.engagementDrafts.findFirst({ where: and(eq(engagementDrafts.id, input.draftId), eq(engagementDrafts.tenantId, input.tenantId)) });
    if (!draft) throw new Error('DRAFT_NOT_FOUND');
    const post = await this.db.query.engagementPosts.findFirst({ where: and(eq(engagementPosts.id, draft.postId), eq(engagementPosts.tenantId, input.tenantId)) });
    const prospect = await this.db.query.prospects.findFirst({ where: and(eq(prospects.id, draft.prospectId), eq(prospects.tenantId, input.tenantId)) });
    let revision = await this.db.query.recommendationRevisions.findFirst({ where: eq(recommendationRevisions.draftId, draft.id), orderBy: (r, { desc }) => [desc(r.revision)] });
    if (!revision && draft.status === 'APPROVED') {
      const [rev] = await this.db.insert(recommendationRevisions).values({
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
    let approval = await this.db.query.recommendationApprovals.findFirst({ where: and(eq(recommendationApprovals.revisionId, revision.id), eq(recommendationApprovals.tenantId, input.tenantId)), orderBy: (a, { desc }) => [desc(a.createdAt)] });
    if (!approval && draft.status === 'APPROVED') {
      const [appr] = await this.db.insert(recommendationApprovals).values({
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
    const control = await this.db.query.engagementControls.findFirst({ where: and(eq(engagementControls.tenantId, input.tenantId), eq(engagementControls.accountId, input.accountId), eq(engagementControls.actionType, request.actionType)) });
    const account = await this.db.query.browserAccounts.findFirst({ where: and(eq(browserAccounts.tenantId, input.tenantId), eq(browserAccounts.id, input.accountId)) });
    if (!control?.enabled || control.killSwitchActive) throw new Error(control?.killSwitchActive ? 'KILL_SWITCH_ACTIVE' : `${request.actionType}_DISABLED`);
    if (control.cooldownUntil && control.cooldownUntil > new Date()) throw new Error('COOLDOWN_ACTIVE');
    const budgetDate = new Date();
    budgetDate.setHours(0, 0, 0, 0);
    const budget = await this.db.query.dailyActionBudgets.findFirst({ where: and(eq(dailyActionBudgets.tenantId, input.tenantId), eq(dailyActionBudgets.accountId, input.accountId), eq(dailyActionBudgets.actionType, request.actionType), eq(dailyActionBudgets.budgetDate, budgetDate)) });
    if (!budget || budget.reservedCount + budget.completedCount >= budget.limit) throw new Error('BUDGET_EXCEEDED');
    if (request.mode === 'BROWSER' && (!account || account.health !== 'HEALTHY' || !account.sessionExpiresAt || account.sessionExpiresAt <= new Date())) throw new Error('SESSION_EXPIRED');
    const payload = { postUrl: post.postUrl, comment: draft.editedText ?? draft.commentText };
    const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const semanticKey = `${input.tenantId}:${input.accountId}:${draft.id}:${revision.id}:${request.actionType}:${request.mode}:${payloadHash}`;
    const enrollment = await this.db.query.campaignEnrollments.findFirst({
      where: eq(campaignEnrollments.prospectId, draft.prospectId),
      orderBy: [desc(campaignEnrollments.createdAt)]
    });
    
    const actionId = uuidv4();
    const outcome = await this.db.transaction(async (tx) => {
      const existingAction = await tx.query.scheduledActions.findFirst({ where: and(eq(scheduledActions.tenantId, input.tenantId), eq(scheduledActions.idempotencyKey, semanticKey)) });
      if (existingAction) {
        if (existingAction.status === 'UNCERTAIN') {
          throw new Error('POST_EXECUTION_UNCERTAIN');
        }
        if (request.actionType === 'COMMENT') {
          const slot = await tx.query.accountPostComments.findFirst({
            where: and(
              eq(accountPostComments.tenantId, input.tenantId),
              eq(accountPostComments.accountId, input.accountId),
              eq(accountPostComments.canonicalPostIdentifier, post.canonicalPostIdentifier),
            ),
          });
          if (slot?.status === 'UNCERTAIN') {
            throw new Error('POST_EXECUTION_UNCERTAIN');
          }
        }
        if (existingAction.status === 'FAILED') {
          await tx.delete(scheduledActions).where(eq(scheduledActions.id, existingAction.id));
        } else {
          return { status: 'QUEUED' as const, action: existingAction, refusal: null };
        }
      }

      if (request.actionType === 'COMMENT') {
        const insertedSlot = await tx.insert(accountPostComments).values({
          tenantId: input.tenantId,
          accountId: input.accountId,
          postHash: post.contentHash,
          canonicalPostIdentifier: post.canonicalPostIdentifier,
          postUrl: post.postUrl,
          status: 'PENDING',
          scheduledActionId: actionId,
        }).onConflictDoNothing().returning();

        if (!insertedSlot[0]) {
          // An explicit retry may only replace a definitively failed owner.
          const reclaimed = await tx.update(accountPostComments).set({
            status: 'PENDING', scheduledActionId: actionId, updatedAt: new Date(),
          }).where(and(
            eq(accountPostComments.tenantId, input.tenantId),
            eq(accountPostComments.accountId, input.accountId),
            eq(accountPostComments.canonicalPostIdentifier, post.canonicalPostIdentifier),
            eq(accountPostComments.status, 'FAILED'),
          )).returning();
          if (!reclaimed[0]) {
            const slot = await tx.query.accountPostComments.findFirst({ where: and(eq(accountPostComments.tenantId, input.tenantId), eq(accountPostComments.accountId, input.accountId), eq(accountPostComments.canonicalPostIdentifier, post.canonicalPostIdentifier)) });
            if (slot?.status === 'UNCERTAIN') throw new Error('POST_EXECUTION_UNCERTAIN');
            throw new Error('POST_ALREADY_COMMENTED');
          }
        }
      }

      const action = await tx.insert(scheduledActions).values({ id: actionId, tenantId: input.tenantId, prospectId: draft.prospectId, campaignEnrollmentId: enrollment?.id, accountId: input.accountId, actionType: request.actionType.toLowerCase(), payload, scheduledFor: new Date(), idempotencyKey: semanticKey, revisionId: revision.id, postHash: post.contentHash, mode: request.mode }).onConflictDoNothing().returning();
      if (!action[0]) throw new Error('ACTION_DUPLICATE');
      return { status: 'QUEUED' as const, action: action[0], refusal: null };
    });
    return outcome;
  }

  async recordManualCompletion(input: ManualCompleteInput): Promise<{ status: string; taskId: string; outcomeLabel?: string }> {
    const { tenantId, operatorId = DEFAULT_OPERATOR_ID } = input;
    if (!input.taskId && !input.draftId) throw new Error('MANUAL_TASK_REQUIRED');
    if (!input.outcome) {
      const draft = await this.db.query.engagementDrafts.findFirst({ where: and(eq(engagementDrafts.id, input.draftId!), eq(engagementDrafts.tenantId, tenantId)) });
      if (!draft) throw new Error(`Draft ${input.draftId} not found`);
      const taskId = uuidv4();
      await this.db.insert(manualTasks).values({ id: taskId, tenantId, actionType: draft.actionType, status: 'PENDING_CONFIRMATION', confirmationMetadata: { draftId: draft.id, postId: draft.postId } });
      return { status: 'PENDING_CONFIRMATION', taskId };
    }
    if (input.taskId) {
      const task = await this.db.update(manualTasks).set({ status: input.outcome, outcomeLabel: input.outcome === 'COMPLETED' ? 'manual-confirmed' : input.outcome === 'FAILED' ? 'failed' : 'uncertain', confirmationActor: operatorId, confirmationMetadata: input.metadata ?? {}, completedAt: new Date() }).where(and(eq(manualTasks.id, input.taskId), eq(manualTasks.tenantId, tenantId), eq(manualTasks.status, 'PENDING_CONFIRMATION'))).returning();
      if (!task[0]) throw new Error('MANUAL_TASK_TERMINAL');
      // Resolve the associated scheduled action to its terminal state as well,
      // so a manually completed task never leaves a claimable action behind.
      const terminalStatus = input.outcome === 'COMPLETED' ? 'COMPLETED' : input.outcome === 'FAILED' ? 'FAILED' : 'UNCERTAIN';
      if (task[0].scheduledActionId) {
        await this.db.update(scheduledActions).set({ status: terminalStatus, outcomeLabel: task[0].outcomeLabel ?? undefined, completedAt: new Date() }).where(and(eq(scheduledActions.id, task[0].scheduledActionId), eq(scheduledActions.tenantId, tenantId)));
        await this.db.update(accountPostComments).set({ status: terminalStatus, updatedAt: new Date() }).where(and(eq(accountPostComments.scheduledActionId, task[0].scheduledActionId), eq(accountPostComments.tenantId, tenantId)));

        if (terminalStatus === 'COMPLETED') {
          const action = await this.db.query.scheduledActions.findFirst({
            where: and(eq(scheduledActions.id, task[0].scheduledActionId), eq(scheduledActions.tenantId, tenantId)),
          });
          if (action && (action.actionType === 'comment' || action.actionType === 'like')) {
            let postId: string | undefined;
            if (action.revisionId) {
              const rev = await this.db.query.recommendationRevisions.findFirst({
                where: and(eq(recommendationRevisions.id, action.revisionId), eq(recommendationRevisions.tenantId, tenantId)),
              });
              if (rev) {
                const draft = await this.db.query.engagementDrafts.findFirst({
                  where: and(eq(engagementDrafts.id, rev.draftId), eq(engagementDrafts.tenantId, tenantId)),
                });
                if (draft) postId = draft.postId;
              }
            }
            if (!postId && action.postHash) {
              const post = await this.db.query.engagementPosts.findFirst({
                where: and(eq(engagementPosts.contentHash, action.postHash), eq(engagementPosts.tenantId, tenantId)),
              });
              if (post) postId = post.id;
            }
            if (!postId) {
              const post = await this.db.query.engagementPosts.findFirst({
                where: and(eq(engagementPosts.prospectId, action.prospectId), eq(engagementPosts.tenantId, tenantId)),
              });
              if (post) postId = post.id;
            }
            if (postId) {
              await this.db.insert(engagementHistory).values({
                id: uuidv4(),
                tenantId,
                prospectId: action.prospectId,
                postId,
                actionType: action.actionType.toUpperCase() as 'LIKE' | 'COMMENT',
                interactedAt: new Date(),
                operatorId,
                scheduledActionId: action.id,
              }).onConflictDoNothing();
            }
          }
        }
      }
      return { status: task[0].status, taskId: task[0].id, outcomeLabel: task[0].outcomeLabel ?? undefined };
    }
    throw new Error('MANUAL_TASK_REQUIRED');
  }

  // ─── List pending drafts for review ───────────────────────────────────────

  async listPendingDrafts(tenantId: string): Promise<EngagementDraft[]> {
    const rows = await this.db.query.engagementDrafts.findMany({
      where: and(
        eq(engagementDrafts.tenantId, tenantId),
        eq(engagementDrafts.status, 'PENDING'),
      ),
    });
    return rows.map(this.mapDraft);
  }

  async listAllDrafts(tenantId: string): Promise<EngagementDraft[]> {
    const rows = await this.db.query.engagementDrafts.findMany({
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

  private async persistRevision(values: typeof recommendationRevisions.$inferInsert, tx: any = this.db): Promise<void> {
    await tx.insert(recommendationRevisions).values(values);
  }

  async reconcileMissingDrafts(
    tenantId: string,
    prospectId?: string,
  ): Promise<{ backfilledComments: number; backfilledLikes: number }> {
    let backfilledComments = 0;
    let backfilledLikes = 0;

    // 1. Fetch relevant posts
    const postConditions = [eq(engagementPosts.tenantId, tenantId)];
    if (prospectId) {
      postConditions.push(eq(engagementPosts.prospectId, prospectId));
    }
    const posts = await withDbRetry(() =>
      this.db.query.engagementPosts.findMany({
        where: and(...postConditions),
      })
    );

    for (const post of posts) {
      const prospect = await withDbRetry(() =>
        this.db.query.prospects.findFirst({
          where: and(eq(prospects.id, post.prospectId), eq(prospects.tenantId, tenantId)),
        })
      );
      if (!prospect || !['APPROVED_FOR_OUTREACH', 'READY_FOR_CAMPAIGN'].includes(prospect.currentStage)) {
        continue;
      }

      const drafts = await withDbRetry(() =>
        this.db.query.engagementDrafts.findMany({
          where: and(
            eq(engagementDrafts.tenantId, tenantId),
            eq(engagementDrafts.postId, post.id),
          ),
        })
      );

      const likeDraft = drafts.find((d) => d.actionType === 'LIKE');
      const commentDraft = drafts.find((d) => d.actionType === 'COMMENT');

      // Case A: LIKE draft exists, COMMENT draft missing
      if (likeDraft && !commentDraft) {
        // Check 1-active comment candidate gate across the prospect
        const existingActiveDrafts = await this.db.query.engagementDrafts.findMany({
          where: and(
            eq(engagementDrafts.tenantId, tenantId),
            eq(engagementDrafts.prospectId, prospect.id),
            eq(engagementDrafts.actionType, 'COMMENT'),
            inArray(engagementDrafts.status, ['PENDING', 'APPROVED']),
          ),
        });

        const existingActiveActions = await this.db.query.scheduledActions.findMany({
          where: and(
            eq(scheduledActions.tenantId, tenantId),
            eq(scheduledActions.prospectId, prospect.id),
            eq(scheduledActions.actionType, 'comment'),
            inArray(scheduledActions.status, ['PENDING', 'CLAIMED']),
          ),
        });

        const existingSlot = await this.db.query.accountPostComments.findFirst({
          where: and(
            eq(accountPostComments.tenantId, tenantId),
            eq(accountPostComments.canonicalPostIdentifier, post.canonicalPostIdentifier),
            inArray(accountPostComments.status, ['PENDING', 'COMPLETED', 'UNCERTAIN']),
          ),
        });

        if (existingActiveDrafts.length === 0 && existingActiveActions.length === 0 && !existingSlot) {
          // Check cooldown
          const historyRows = await this.db.query.engagementHistory.findMany({
            where: and(
              eq(engagementHistory.tenantId, tenantId),
              eq(engagementHistory.prospectId, prospect.id),
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

          const cooldownCheck = this.cooldown.checkComment(prospect.id, history);
          if (cooldownCheck.allowed) {
            try {
              const aiDraft = await this.generateCommentWithRetry({
                postText: post.postText,
                authorName: post.authorName,
                prospectLinkedInUrl: prospect.linkedinUrl,
              });

              const validation = this.validator.validate(aiDraft.commentText, post.postText);

              const created = await withDbRetry(async () => {
                return await this.db.transaction(async (tx) => {
                  const check = await tx.query.engagementDrafts.findFirst({
                    where: and(
                      eq(engagementDrafts.postId, post.id),
                      eq(engagementDrafts.tenantId, tenantId),
                      eq(engagementDrafts.actionType, 'COMMENT'),
                    ),
                  });
                  if (check) return false;

                  const inserted = await tx.insert(engagementDrafts).values({
                    id: uuidv4(),
                    tenantId,
                    postId: post.id,
                    prospectId: prospect.id,
                    actionType: 'COMMENT',
                    commentText: aiDraft.commentText,
                    status: 'PENDING',
                    provider: this.aiProvider.providerName,
                    providerMetadata: aiDraft.providerMeta ?? {},
                    validationReport: {
                      valid: validation.valid,
                      reasons: validation.reasons,
                      groundingEvidence: aiDraft.groundingEvidence,
                    },
                  }).returning();

                  await this.persistRevision({
                    tenantId,
                    draftId: inserted[0].id,
                    revision: 1,
                    actionType: 'COMMENT',
                    postHash: post.contentHash,
                    commentText: aiDraft.commentText,
                    evidence: { groundingEvidence: aiDraft.groundingEvidence },
                    validationReport: { valid: validation.valid, reasons: validation.reasons },
                    state: 'PENDING',
                  }, tx);

                  return true;
                });
              });

              if (created) {
                backfilledComments++;
              }
            } catch (err) {
              console.warn(`[EngagementService] Reconcile comment backfill failed for post ${post.id}:`, (err as Error).message);
            }
          }
        }
      }

      // Case B: COMMENT draft exists, LIKE draft missing
      if (commentDraft && !likeDraft) {
        const historyRows = await this.db.query.engagementHistory.findMany({
          where: and(
            eq(engagementHistory.tenantId, tenantId),
            eq(engagementHistory.prospectId, prospect.id),
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

        const cooldownCheck = this.cooldown.checkLike(prospect.id, history);
        if (cooldownCheck.allowed) {
          try {
            const created = await withDbRetry(async () => {
              return await this.db.transaction(async (tx) => {
                const check = await tx.query.engagementDrafts.findFirst({
                  where: and(
                    eq(engagementDrafts.postId, post.id),
                    eq(engagementDrafts.tenantId, tenantId),
                    eq(engagementDrafts.actionType, 'LIKE'),
                  ),
                });
                if (check) return false;

                const inserted = await tx.insert(engagementDrafts).values({
                  id: uuidv4(),
                  tenantId,
                  postId: post.id,
                  prospectId: prospect.id,
                  actionType: 'LIKE',
                  commentText: 'LIKE',
                  status: 'PENDING',
                  provider: 'SYSTEM',
                  providerMetadata: {},
                  validationReport: { valid: true, reasons: [] },
                }).returning();

                await this.persistRevision({
                  tenantId,
                  draftId: inserted[0].id,
                  revision: 1,
                  actionType: 'LIKE',
                  postHash: post.contentHash,
                  commentText: 'LIKE',
                  evidence: {},
                  validationReport: { valid: true, reasons: [] },
                  state: 'PENDING',
                }, tx);

                return true;
              });
            });

            if (created) {
              backfilledLikes++;
            }
          } catch (err) {
            console.warn(`[EngagementService] Reconcile LIKE backfill failed for post ${post.id}:`, (err as Error).message);
          }
        }
      }
    }

    return { backfilledComments, backfilledLikes };
  }

  async scanCampaignResume(
    firstArg?: string,
    secondArg?: string,
  ): Promise<{ status: 'completed'; prospectsScanned: number; draftsBackfilled: number; errors: string[] }> {
    let tenantId = '00000000-0000-0000-0000-000000000001';
    let campaignId: string | undefined;

    const arg1 = firstArg?.trim() || undefined;
    const arg2 = secondArg?.trim() || undefined;

    if (arg1 && arg2) {
      tenantId = arg1;
      campaignId = arg2;
    } else if (arg1 && !arg2) {
      const foundCampaign = await withDbRetry(() =>
        this.db.query.campaigns.findFirst({
          where: eq(campaigns.id, arg1),
        })
      ).catch(() => undefined);

      if (foundCampaign) {
        campaignId = arg1;
        tenantId = foundCampaign.tenantId;
      } else {
        tenantId = arg1;
        campaignId = undefined;
      }
    } else if (!arg1 && arg2) {
      campaignId = arg2;
      const foundCampaign = await withDbRetry(() =>
        this.db.query.campaigns.findFirst({
          where: eq(campaigns.id, arg2),
        })
      ).catch(() => undefined);

      if (foundCampaign) {
        tenantId = foundCampaign.tenantId;
      }
    }

    const errors: string[] = [];
    let prospectsScanned = 0;
    let draftsBackfilled = 0;

    let targetProspects: Array<{ id: string; tenantId: string }> = [];

    if (campaignId) {
      const enrollments = await withDbRetry(() =>
        this.db.query.campaignEnrollments.findMany({
          where: eq(campaignEnrollments.campaignId, campaignId),
        })
      );
      for (const e of enrollments) {
        const p = await withDbRetry(() =>
          this.db.query.prospects.findFirst({
            where: eq(prospects.id, e.prospectId),
          })
        );
        if (p && ['READY_FOR_CAMPAIGN', 'APPROVED_FOR_OUTREACH'].includes(p.currentStage)) {
          if (!tenantId || p.tenantId === tenantId) {
            targetProspects.push({ id: p.id, tenantId: p.tenantId });
          }
        }
      }
    } else {
      const readyProspects = await withDbRetry(() =>
        this.db.query.prospects.findMany({
          where: and(
            eq(prospects.tenantId, tenantId),
            inArray(prospects.currentStage, ['READY_FOR_CAMPAIGN', 'APPROVED_FOR_OUTREACH']),
          ),
        })
      );
      targetProspects = readyProspects.map((p) => ({ id: p.id, tenantId: p.tenantId }));
    }

    for (const p of targetProspects) {
      try {
        const scanRes = await this.scanProspect(p.tenantId, p.id);
        prospectsScanned++;
        if (scanRes.errors && scanRes.errors.length > 0) {
          errors.push(...scanRes.errors);
        }

        const reconcileRes = await this.reconcileMissingDrafts(p.tenantId, p.id);
        draftsBackfilled += (reconcileRes.backfilledComments + reconcileRes.backfilledLikes);
      } catch (err: any) {
        errors.push(`Prospect ${p.id} resume failed: ${err.message}`);
      }
    }

    return {
      status: 'completed',
      prospectsScanned,
      draftsBackfilled,
      errors,
    };
  }

  async createLikeRecommendation(tenantId: string, prospectId: string, postId: string): Promise<EngagementDraft> {
    const post = await this.db.query.engagementPosts.findFirst({ where: and(eq(engagementPosts.id, postId), eq(engagementPosts.tenantId, tenantId), eq(engagementPosts.prospectId, prospectId)) });
    if (!post) throw new Error('POST_NOT_FOUND');
    const existing = await this.db.query.engagementDrafts.findFirst({ where: and(eq(engagementDrafts.postId, postId), eq(engagementDrafts.tenantId, tenantId), eq(engagementDrafts.actionType, 'LIKE')) });
    if (existing) return this.mapDraft(existing);
    const draft = await this.db.insert(engagementDrafts).values({
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
