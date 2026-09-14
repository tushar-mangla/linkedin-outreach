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

    const validPosts: RawPost[] = [];
    for (const post of posts) {
      const reason = this.rejectReason(post, cutoff);
      if (reason) {
        rejected.push({ post, reason });
      } else {
        validPosts.push(post);
      }
    }

    // Rank valid posts by engagement score descending
    validPosts.sort((a, b) => this.getEngagementScore(b) - this.getEngagementScore(a));

    // Keep the top post if available
    if (validPosts.length > 0) {
      kept.push(validPosts[0]);
      for (const post of validPosts.slice(1)) {
        rejected.push({ post, reason: 'Exceeded maximum of 1 kept post' });
      }
    }

    return { kept, rejected };
  }

  private rejectReason(post: RawPost, cutoff: Date): string | null {
    if (post.publishedAt && post.publishedAt < cutoff) {
      return `Post is older than ${this.maxAgeDays} days`;
    }

    return this.rejectContentReason(post);
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

  private getEngagementScore(post: RawPost): number {
    const p = post as any;
    if (typeof p.engagementScore === 'number') {
      return p.engagementScore;
    }
    const likes = p.likesCount ?? p.likes ?? p.reactionsCount ?? 0;
    const comments = p.commentsCount ?? p.comments ?? 0;
    const shares = p.sharesCount ?? p.repostsCount ?? p.shares ?? 0;
    return likes + comments * 2 + shares * 3;
  }
}
