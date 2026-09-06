import type { RawPost } from './prospect-post-source.js';

// ─── PostFilter ───────────────────────────────────────────────────────────────

export interface PostFilterOptions {
  /** Maximum post age in days (default: 7) */
  maxAgeDays?: number;
  /** Minimum text length in characters (default: 50) */
  minTextLength?: number;
  /** Optional keyword allow-list: post must mention at least one (if provided) */
  requiredKeywords?: string[];
}

export interface FilterResult {
  kept: RawPost[];
  rejected: Array<{ post: RawPost; reason: string }>;
}

/**
 * Filters raw posts from a ProspectPostSource to only keep relevant,
 * recent, non-trivial posts worth engaging with.
 */
export class PostFilter {
  private readonly maxAgeDays: number;
  private readonly minTextLength: number;
  private readonly requiredKeywords: string[];

  constructor(opts: PostFilterOptions = {}) {
    this.maxAgeDays = opts.maxAgeDays ?? 7;
    this.minTextLength = opts.minTextLength ?? 50;
    this.requiredKeywords = (opts.requiredKeywords ?? []).map((k) => k.toLowerCase());
  }

  filter(posts: RawPost[]): FilterResult {
    const kept: RawPost[] = [];
    const rejected: FilterResult['rejected'] = [];
    const cutoff = new Date(Date.now() - this.maxAgeDays * 24 * 60 * 60 * 1000);

    // 1. First pass: filter out by text length and keywords
    const contentValidPosts = [];
    for (const post of posts) {
      const reason = this.rejectContentReason(post);
      if (reason) {
        rejected.push({ post, reason });
      } else {
        contentValidPosts.push(post);
      }
    }

    // 2. Separate into recent vs older (assuming they are already ordered newest-first)
    const recentPosts = [];
    const olderPosts = [];
    
    for (const post of contentValidPosts) {
      if (post.publishedAt && post.publishedAt < cutoff) {
        olderPosts.push(post);
      } else {
        recentPosts.push(post);
      }
    }

    // 3. Apply the selection rule:
    // - If we have recent posts, keep up to 2 of them.
    // - If we have no recent posts, keep exactly 1 older post (the latest one).
    if (recentPosts.length > 0) {
      kept.push(...recentPosts.slice(0, 2));
      
      // Reject the rest
      for (const post of recentPosts.slice(2)) {
        rejected.push({ post, reason: 'Exceeded maximum of 2 recent posts' });
      }
      for (const post of olderPosts) {
        rejected.push({ post, reason: `Post is older than ${this.maxAgeDays} days (and recent posts exist)` });
      }
    } else if (olderPosts.length > 0) {
      kept.push(olderPosts[0]);
      
      for (const post of olderPosts.slice(1)) {
        rejected.push({ post, reason: 'Fallback to latest 1 older post already satisfied' });
      }
    }

    return { kept, rejected };
  }

  private rejectContentReason(post: RawPost): string | null {
    const text = post.postText.trim();

    if (text.length < this.minTextLength) {
      return `Post text too short (${text.length} < ${this.minTextLength} chars)`;
    }

    if (this.requiredKeywords.length > 0) {
      const lower = text.toLowerCase();
      const hasKeyword = this.requiredKeywords.some((k) => lower.includes(k));
      if (!hasKeyword) {
        return `Post does not mention any required keywords: ${this.requiredKeywords.join(', ')}`;
      }
    }

    return null;
  }
}
