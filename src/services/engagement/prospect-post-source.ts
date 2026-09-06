import { createHash } from 'node:crypto';
import type { LinkedInPost, PostSourceType } from '../../types.js';

// ─── ProspectPostSource interface ────────────────────────────────────────────

/**
 * Interface for discovering recent LinkedIn posts for a given approved prospect.
 * Different implementations: FixturePostSource (tests), ProfileActivityPostSource (Playwright).
 */
export interface ProspectPostSource {
  /**
   * Find recent posts authored by the prospect at the given LinkedIn profile URL.
   * Returns an empty array if no posts are found within the recency window.
   */
  findRecentPosts(
    prospectId: string,
    tenantId: string,
    profileUrl: string,
  ): Promise<RawPost[]>;

  readonly sourceType: PostSourceType;
}

export interface RawPost {
  postUrl: string;
  postText: string;
  authorName: string;
  publishedAt?: Date;
}

// ─── Content hash helper ──────────────────────────────────────────────────────

export function hashPostContent(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex');
}


// ─── Normalise raw posts to LinkedInPost records ──────────────────────────────

export function normaliseRawPost(
  raw: RawPost,
  prospectId: string,
  tenantId: string,
  sourceType: PostSourceType,
): Omit<LinkedInPost, 'id' | 'createdAt'> {
  return {
    tenantId,
    prospectId,
    postUrl: raw.postUrl,
    postText: raw.postText,
    authorName: raw.authorName,
    publishedAt: raw.publishedAt,
    sourceType,
    contentHash: hashPostContent(raw.postText),
  };
}
