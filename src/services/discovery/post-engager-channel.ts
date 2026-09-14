import type { DBAdapter } from '../../db/db-adapter.js';
import type { EngagerTargetType, ProspectStage } from '../../types.js';
import { normalizeLinkedinUrl } from '../icp/url-normalizer.js';
import { EngagerTargetRegistry } from './engager-target-registry.js';
import { POST_ENGAGER_SOURCE } from './engager-target-seeds.js';
import type { PostEngagerEntry, PostEngagerRunner, PostRecency, TargetPost } from './opencli-post-engager-runner.js';

export { POST_ENGAGER_SOURCE, type PostRecency };

export const CHANNEL5_SOURCES_LIMIT = 10;
export const MAX_POSTS_PER_TARGET = 10;
export const MAX_ENGAGERS_PER_POST = 50;
export const DEFAULT_MAX_POSTS_PER_TARGET = 3;
export const DEFAULT_MAX_ENGAGERS_PER_POST = 20;
export const CHANNEL5_SYSTEM_ACTOR = 'system-channel-5';

export type PostEngagerInteraction = 'LIKE' | 'COMMENT';

export interface Channel5SourceMetadata {
  name: string;
  title?: string;
  source: typeof POST_ENGAGER_SOURCE;
  sourceTarget: string;
  sourceTargetType: EngagerTargetType;
  sourceTargetUrl: string;
  sourcePostUrl: string;
  sourceInteraction: PostEngagerInteraction;
  sourceCommentText?: string;
  sourceObservedAt: string;
}

/** One bounded evidence entry kept on `customAttributes.channel5Sources`. */
export interface Channel5SourceEvidence {
  sourceTarget: string;
  sourceTargetType: EngagerTargetType;
  sourceTargetUrl: string;
  sourcePostUrl: string;
  sourceInteraction: PostEngagerInteraction;
  sourceCommentText?: string;
  sourceObservedAt: string;
}

export interface EngageProspectResult {
  draftsCreated: number;
  postsFound: number;
  alreadyScheduled?: boolean;
  existingDrafts?: number;
}

export interface PostEngagerChannelDeps {
  runner: PostEngagerRunner;
  db: DBAdapter;
  registry: EngagerTargetRegistry;
  /**
   * Warm-up hook wired to EngagementService.scanProspect in production. It
   * ingests the engager's own recent posts and creates/reuses one LIKE and one
   * contextual COMMENT draft for an eligible post. Returns how many brand-new
   * drafts were created for this prospect and how many raw posts were found.
   */
  engageProspect?: (tenantId: string, prospectId: string) => Promise<EngageProspectResult>;
  now?: () => Date;
}

export interface PostEngagerRunOptions {
  targetIds?: string[];
  recency?: PostRecency;
  maxPostsPerTarget?: number;
  maxEngagersPerPost?: number;
}

export type EngagerOutcome = 'stored' | 'ready' | 'duplicate' | 'no-eligible-prospect-post' | 'draft-created';

export interface EngagerProspectResult {
  prospectId: string;
  name: string;
  headline: string | null;
  linkedinUrl: string;
  interaction: PostEngagerInteraction;
  targetId: string;
  targetName: string;
  sourcePostUrl: string;
  outcome: EngagerOutcome;
  stage: ProspectStage;
  draftCount: number;
}

export interface PostEngagerTargetResult {
  targetId: string;
  targetName: string;
  postsFound: number;
  engagersFound: number;
  qualified: number;
  duplicates: number;
  filtered: number;
  noEligibleProspectPost: number;
  draftCreated: number;
  error: string | null;
}

export interface PostEngagerRunResult {
  status: 'completed' | 'partial';
  targets: PostEngagerTargetResult[];
  counts: {
    targets: number;
    posts: number;
    engagers: number;
    qualified: number;
    duplicates: number;
    filtered: number;
    noEligibleProspectPost: number;
    draftCreated: number;
  };
  prospects: EngagerProspectResult[];
}

// ─── Pure qualification & metadata helpers (unit-tested) ─────────────────────

export type QualifyVerdict = { ok: true; normalizedUrl: string } | { ok: false; reason: string };

/**
 * Channel 5 qualification policy for recruitment-sales prospects: a visible
 * name plus a canonical personal LinkedIn profile URL. Malformed profile URLs,
 * non-profile URLs, and nameless entries are rejected and never create rows.
 */
export function qualifyEngager(entry: PostEngagerEntry): QualifyVerdict {
  if (!entry || typeof entry.profileUrl !== 'string' || !entry.profileUrl.trim()) {
    return { ok: false, reason: 'MISSING_PROFILE_URL' };
  }
  if (typeof entry.name !== 'string' || !entry.name.trim()) {
    return { ok: false, reason: 'MISSING_NAME' };
  }
  let normalizedUrl: string;
  try {
    normalizedUrl = normalizeLinkedinUrl(entry.profileUrl);
  } catch {
    return { ok: false, reason: 'INVALID_PROFILE_URL' };
  }
  if (!/^https:\/\/linkedin\.com\/in\//.test(normalizedUrl)) {
    return { ok: false, reason: 'NOT_PROFILE_URL' };
  }
  return { ok: true, normalizedUrl };
}

export function channel5SourceEvidence(source: Channel5SourceMetadata): Channel5SourceEvidence {
  return {
    sourceTarget: source.sourceTarget,
    sourceTargetType: source.sourceTargetType,
    sourceTargetUrl: source.sourceTargetUrl,
    sourcePostUrl: source.sourcePostUrl,
    sourceInteraction: source.sourceInteraction,
    ...(source.sourceCommentText ? { sourceCommentText: source.sourceCommentText } : {}),
    sourceObservedAt: source.sourceObservedAt,
  };
}

/**
 * Merge Channel 5 source metadata into a prospect's customAttributes.
 *
 * - New prospects receive the full Channel 5 contract (first-source fields +
 *   a one-entry `channel5Sources` evidence list).
 * - Existing prospects keep every curated value (`name`, `title`, lifecycle
 *   stage is untouched by callers, and the first `source` fields from any
 *   channel); only the bounded `channel5Sources` evidence list is appended,
 *   truncated to `CHANNEL5_SOURCES_LIMIT` most-recent entries so repeated
 *   extraction never grows the JSON without limit.
 */
export function mergeChannel5SourceMetadata(
  existing: unknown,
  source: Channel5SourceMetadata,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const rawSources = Array.isArray(base.channel5Sources) ? base.channel5Sources : [];
  const sources = [...rawSources.filter((item): item is Channel5SourceEvidence =>
    item !== null && typeof item === 'object' && typeof (item as { sourcePostUrl?: unknown }).sourcePostUrl === 'string'
  )];
  sources.push(channel5SourceEvidence(source));
  const bounded = sources.length > CHANNEL5_SOURCES_LIMIT
    ? sources.slice(sources.length - CHANNEL5_SOURCES_LIMIT)
    : sources;

  const merged: Record<string, unknown> = { ...base, channel5Sources: bounded };

  // First-source preservation: fill only when absent.
  if (typeof merged.name !== 'string' || !merged.name) merged.name = source.name;
  if ((!merged.title || typeof merged.title !== 'string') && source.title) merged.title = source.title;
  if (!merged.source) merged.source = source.source;
  if (!merged.sourceTarget) merged.sourceTarget = source.sourceTarget;
  if (!merged.sourceTargetType) merged.sourceTargetType = source.sourceTargetType;
  if (!merged.sourceTargetUrl) merged.sourceTargetUrl = source.sourceTargetUrl;
  if (!merged.sourcePostUrl) merged.sourcePostUrl = source.sourcePostUrl;
  if (!merged.sourceInteraction) merged.sourceInteraction = source.sourceInteraction;
  if (!merged.sourceCommentText && source.sourceCommentText) merged.sourceCommentText = source.sourceCommentText;
  if (!merged.sourceObservedAt) merged.sourceObservedAt = source.sourceObservedAt;

  return merged;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ─── Channel 5 orchestration ─────────────────────────────────────────────────

/**
 * Channel 5 — competitor & influencer post-engager sourcing.
 *
 * Flow: resolve active selected targets -> fetch each target's recent posts ->
 * fetch public likers/commenters per post -> qualify -> upsert prospects by the
 * canonical LinkedIn URL -> merge bounded Channel 5 source metadata -> newly
 * created prospects are autonomously transitioned to READY_FOR_CAMPAIGN by the
 * explicit system actor (review decision + audit event) -> the warm-up hook
 * scans each ready engager's own posts and creates/reuses LIKE + COMMENT drafts.
 *
 * This channel NEVER writes to `scheduled_actions` directly. Drafts are drained
 * by the existing `autoApproveAndQueueCycle` -> `EngagementService.requestAction`
 * path and executed by the native five-minute queue worker. Structured failures
 * never fabricate prospects, drafts, or queued actions.
 */
export class PostEngagerChannel {
  private readonly deps: PostEngagerChannelDeps;

  constructor(deps: PostEngagerChannelDeps) {
    this.deps = deps;
  }

  async run(tenantId: string, options: PostEngagerRunOptions = {}): Promise<PostEngagerRunResult> {
    const maxPostsPerTarget = clamp(options.maxPostsPerTarget ?? DEFAULT_MAX_POSTS_PER_TARGET, 1, MAX_POSTS_PER_TARGET);
    const maxEngagersPerPost = clamp(options.maxEngagersPerPost ?? DEFAULT_MAX_ENGAGERS_PER_POST, 1, MAX_ENGAGERS_PER_POST);

    const allActive = await this.deps.registry.list(tenantId, { activeOnly: true });
    let targets = allActive;

    if (options.targetIds !== undefined) {
      if (options.targetIds.length === 0) {
        throw new Error('NO_ACTIVE_TARGETS');
      }
      const requested = new Set(options.targetIds);
      targets = allActive.filter(t => requested.has(t.id));
      const resolvedIds = new Set(targets.map(t => t.id));
      const missing = [...requested].filter(id => !resolvedIds.has(id));
      if (missing.length > 0) {
        const allKnown = await this.deps.registry.list(tenantId);
        const knownIds = new Set(allKnown.map(t => t.id));
        const unknown = missing.filter(id => !knownIds.has(id));
        const inactive = missing.filter(id => knownIds.has(id));
        if (unknown.length > 0) throw new Error('TARGET_NOT_FOUND');
        if (inactive.length > 0) throw new Error('TARGET_NOT_ACTIVE');
      }
    }

    if (targets.length === 0) throw new Error('NO_ACTIVE_TARGETS');

    const counts = {
      targets: targets.length,
      posts: 0,
      engagers: 0,
      qualified: 0,
      duplicates: 0,
      filtered: 0,
      noEligibleProspectPost: 0,
      draftCreated: 0,
    };
    const prospects: EngagerProspectResult[] = [];
    const targetResults: PostEngagerTargetResult[] = [];
    const seenProspectUrls = new Set<string>();
    let anyError = false;

    for (const target of targets) {
      const perTarget: PostEngagerTargetResult = {
        targetId: target.id,
        targetName: target.displayName,
        postsFound: 0,
        engagersFound: 0,
        qualified: 0,
        duplicates: 0,
        filtered: 0,
        noEligibleProspectPost: 0,
        draftCreated: 0,
        error: null,
      };

      try {
        const posts = await this.deps.runner.fetchRecentPosts(target.linkedinUrl, options.recency);
        perTarget.postsFound = posts.length;

        for (const post of posts.slice(0, maxPostsPerTarget)) {
          counts.posts += 1;

          let engagers: PostEngagerEntry[];
          try {
            engagers = await this.deps.runner.fetchEngagers(post.postUrl);
          } catch (err) {
            perTarget.error = errorCode(err);
            anyError = true;
            continue;
          }
          perTarget.engagersFound += engagers.length;

          for (const entry of engagers.slice(0, maxEngagersPerPost)) {
            counts.engagers += 1;
            const verdict = qualifyEngager(entry);
            if (!verdict.ok) {
              perTarget.filtered += 1;
              counts.filtered += 1;
              continue;
            }

            if (seenProspectUrls.has(verdict.normalizedUrl)) {
              perTarget.duplicates += 1;
              counts.duplicates += 1;
              continue;
            }
            seenProspectUrls.add(verdict.normalizedUrl);

            try {
              const handled = await this.processEngager(tenantId, target.id, target, post, entry, verdict.normalizedUrl);
              perTarget[handled.primaryCountKey] += 1;
              counts[handled.primaryCountKey] += 1;
              if (handled.secondaryCountKey) {
                perTarget[handled.secondaryCountKey] += 1;
                counts[handled.secondaryCountKey] += 1;
              }
              if (handled.result) prospects.push(handled.result);
            } catch (err) {
              perTarget.error = errorCode(err);
              anyError = true;
              continue;
            }
          }
        }
      } catch (err) {
        perTarget.error = errorCode(err);
        anyError = true;
      }

      targetResults.push(perTarget);
    }

    return {
      status: anyError ? 'partial' : 'completed',
      targets: targetResults,
      counts,
      prospects,
    };
  }

  private async processEngager(
    tenantId: string,
    targetId: string,
    target: { id: string; displayName: string; targetType: EngagerTargetType; linkedinUrl: string },
    post: TargetPost,
    entry: PostEngagerEntry,
    normalizedUrl: string,
  ): Promise<{
    result: EngagerProspectResult | null;
    primaryCountKey: 'qualified' | 'duplicates';
    secondaryCountKey: 'noEligibleProspectPost' | 'draftCreated' | null;
  }> {
    const observedAt = (this.deps.now?.() ?? new Date()).toISOString();
    const source: Channel5SourceMetadata = {
      name: entry.name,
      ...(entry.headline ? { title: entry.headline } : {}),
      source: POST_ENGAGER_SOURCE,
      sourceTarget: target.displayName,
      sourceTargetType: target.targetType,
      sourceTargetUrl: target.linkedinUrl,
      sourcePostUrl: post.postUrl,
      sourceInteraction: entry.interaction,
      ...(entry.commentText ? { sourceCommentText: entry.commentText } : {}),
      sourceObservedAt: observedAt,
    };

    const existing = await this.deps.db.findProspectByTenantAndUrl(tenantId, normalizedUrl);
    let prospect = existing;
    let isNew = false;

    if (!prospect) {
      prospect = await this.deps.db.insertProspect({
        tenantId,
        linkedinUrl: entry.profileUrl,
        normalizedLinkedinUrl: normalizedUrl,
        customAttributes: mergeChannel5SourceMetadata(undefined, source),
      });
      isNew = true;
    } else {
      await this.deps.db.updateProspect(prospect.id, {
        customAttributes: mergeChannel5SourceMetadata(prospect.customAttributes, source),
      });
    }

    let outcome: EngagerOutcome;
    let draftCount = 0;

    if (isNew) {
      // Fully autonomous handoff: Channel 5 is the only channel that readies a
      // prospect without an operator promote click. Records the system decision
      // and audit event under the explicit system-channel-5 actor.
      await this.deps.db.applyOverride(tenantId, prospect.id, 'READY_FOR_CAMPAIGN');
      await this.deps.db.insertReviewDecision({
        tenantId,
        prospectId: prospect.id,
        decision: 'APPROVED',
        reason: 'Channel 5: qualified competitor/influencer post engager',
        operatorId: CHANNEL5_SYSTEM_ACTOR,
      });
      await this.deps.db.insertAuditEvent({
        tenantId,
        eventType: 'prospect.ready_for_campaign',
        entityType: 'prospect',
        entityId: prospect.id,
        payload: {
          decision: 'APPROVED',
          newStage: 'READY_FOR_CAMPAIGN',
          actor: CHANNEL5_SYSTEM_ACTOR,
          source: POST_ENGAGER_SOURCE,
          sourceTarget: target.displayName,
          sourceInteraction: entry.interaction,
        },
      });
      outcome = 'ready';
    } else {
      // Existing prospects keep their lifecycle stage (no overwrite except for
      // the metadata merge above). Only campaign-ready ones can be warm-scanned.
      outcome = 'duplicate';
      if (prospect.currentStage !== 'READY_FOR_CAMPAIGN' && prospect.currentStage !== 'APPROVED_FOR_OUTREACH') {
        return {
          result: {
            prospectId: prospect.id,
            name: entry.name,
            headline: entry.headline ?? null,
            linkedinUrl: entry.profileUrl,
            interaction: entry.interaction,
            targetId,
            targetName: target.displayName,
            sourcePostUrl: post.postUrl,
            outcome,
            stage: prospect.currentStage,
            draftCount: 0,
          },
          primaryCountKey: 'duplicates',
          secondaryCountKey: null,
        };
      }
    }

    let secondaryCountKey: 'noEligibleProspectPost' | 'draftCreated' | null = null;
    if (this.deps.engageProspect) {
      const scan = await this.deps.engageProspect(tenantId, prospect.id);
      draftCount = scan?.draftsCreated ?? 0;
      if (draftCount > 0) {
        outcome = 'draft-created';
        secondaryCountKey = 'draftCreated';
      } else if (scan?.existingDrafts && scan.existingDrafts > 0) {
        outcome = 'draft-created';
        draftCount = scan.existingDrafts;
        secondaryCountKey = 'draftCreated';
      } else if (scan?.alreadyScheduled) {
        outcome = 'duplicate';
        secondaryCountKey = null;
      } else if (!isNew && (scan?.postsFound ?? 0) > 0) {
        outcome = 'duplicate';
        secondaryCountKey = null;
      } else if (!isNew && (prospect.currentStage === 'READY_FOR_CAMPAIGN' || prospect.currentStage === 'APPROVED_FOR_OUTREACH')) {
        outcome = 'duplicate';
        secondaryCountKey = null;
      } else {
        outcome = 'no-eligible-prospect-post';
        secondaryCountKey = 'noEligibleProspectPost';
      }
    }

    const result: EngagerProspectResult = {
      prospectId: prospect.id,
      name: entry.name,
      headline: entry.headline ?? null,
      linkedinUrl: entry.profileUrl,
      interaction: entry.interaction,
      targetId,
      targetName: target.displayName,
      sourcePostUrl: post.postUrl,
      outcome,
      stage: isNew ? 'READY_FOR_CAMPAIGN' : prospect.currentStage,
      draftCount,
    };

    return {
      result,
      primaryCountKey: isNew ? 'qualified' : 'duplicates',
      secondaryCountKey,
    };
  }
}

function errorCode(err: unknown): string {
  return err instanceof Error && err.message ? err.message.split('\n')[0].trim() : 'UNKNOWN_EXTRACTION_ERROR';
}