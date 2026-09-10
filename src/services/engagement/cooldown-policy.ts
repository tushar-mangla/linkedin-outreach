import type { EngagementHistory } from '../../types.js';

// ─── CooldownPolicy ───────────────────────────────────────────────────────────
//
// Enforces per-prospect engagement cooldowns:
//   - Comments: 14 days between comments to the same prospect
//   - Likes:    5 days between likes to the same prospect
// Also enforces daily global caps across all prospects.

export interface CooldownConfig {
  commentCooldownDays?: number;
  likeCooldownDays?: number;
  dailyCommentCap?: number;
  dailyLikeCap?: number;
}

export interface CooldownCheckResult {
  allowed: boolean;
  reason?: string;
  nextAllowedAt?: Date;
}

export class CooldownPolicy {
  private readonly commentCooldownMs: number;
  private readonly likeCooldownMs: number;
  private readonly dailyCommentCap: number;
  private readonly dailyLikeCap: number;

  constructor(config: CooldownConfig = {}) {
    const days = (d: number) => d * 24 * 60 * 60 * 1000;
    this.commentCooldownMs = days(config.commentCooldownDays ?? 14);
    this.likeCooldownMs = days(config.likeCooldownDays ?? 5);
    this.dailyCommentCap = config.dailyCommentCap ?? 5;
    this.dailyLikeCap = config.dailyLikeCap ?? 10;
  }

  /**
   * Check if a COMMENT action is allowed for this prospect.
   * @param prospectId - the prospect being targeted
   * @param history    - all engagement_history records for this tenant (today)
   * @param now        - optional evaluation timestamp (defaults to current date)
   */
  checkComment(prospectId: string, history: EngagementHistory[], now: Date = new Date()): CooldownCheckResult {
    const comments = history.filter(
      (h) => h.actionType === 'COMMENT' && h.prospectId === prospectId,
    );

    if (comments.length > 0) {
      const lastComment = comments.sort(
        (a, b) => b.interactedAt.getTime() - a.interactedAt.getTime(),
      )[0];
      const elapsed = now.getTime() - lastComment.interactedAt.getTime();
      if (elapsed < this.commentCooldownMs) {
        const nextAllowedAt = new Date(
          lastComment.interactedAt.getTime() + this.commentCooldownMs,
        );
        return {
          allowed: false,
          reason: `Comment cooldown active. Last commented ${Math.floor(elapsed / 86400000)} day(s) ago. Next allowed: ${nextAllowedAt.toDateString()}`,
          nextAllowedAt,
        };
      }
    }

    // Daily cap check
    const todayComments = history.filter(
      (h) => h.actionType === 'COMMENT' && this.isToday(h.interactedAt, now),
    );
    if (todayComments.length >= this.dailyCommentCap) {
      return {
        allowed: false,
        reason: `Daily comment cap reached (${this.dailyCommentCap}/day). Try again tomorrow.`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check if a LIKE action is allowed for this prospect.
   */
  checkLike(prospectId: string, history: EngagementHistory[], now: Date = new Date()): CooldownCheckResult {
    const likes = history.filter(
      (h) => h.actionType === 'LIKE' && h.prospectId === prospectId,
    );

    if (likes.length > 0) {
      const lastLike = likes.sort(
        (a, b) => b.interactedAt.getTime() - a.interactedAt.getTime(),
      )[0];
      const elapsed = now.getTime() - lastLike.interactedAt.getTime();
      if (elapsed < this.likeCooldownMs) {
        const nextAllowedAt = new Date(
          lastLike.interactedAt.getTime() + this.likeCooldownMs,
        );
        return {
          allowed: false,
          reason: `Like cooldown active. Last liked ${Math.floor(elapsed / 86400000)} day(s) ago. Next allowed: ${nextAllowedAt.toDateString()}`,
          nextAllowedAt,
        };
      }
    }

    // Daily cap check
    const todayLikes = history.filter(
      (h) => h.actionType === 'LIKE' && this.isToday(h.interactedAt, now),
    );
    if (todayLikes.length >= this.dailyLikeCap) {
      return {
        allowed: false,
        reason: `Daily like cap reached (${this.dailyLikeCap}/day). Try again tomorrow.`,
      };
    }

    return { allowed: true };
  }

  private isToday(date: Date, now: Date = new Date()): boolean {
    return (
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()
    );
  }
}
