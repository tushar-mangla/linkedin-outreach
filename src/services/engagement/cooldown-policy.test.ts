import { describe, expect, it } from 'vitest';
import { CooldownPolicy } from './cooldown-policy.js';
import type { EngagementHistory } from '../../types.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const PROSPECT_A = '00000000-0000-0000-0000-000000000002';
const PROSPECT_B = '00000000-0000-0000-0000-000000000003';
const POST_ID = '00000000-0000-0000-0000-000000000004';
const OPERATOR_ID = 'operator-1';

function createHistory(
  prospectId: string,
  actionType: 'LIKE' | 'COMMENT',
  interactedAt: Date,
  id = 'h-1',
): EngagementHistory {
  return {
    id,
    tenantId: TENANT_ID,
    prospectId,
    postId: POST_ID,
    actionType,
    interactedAt,
    operatorId: OPERATOR_ID,
  };
}

describe('CooldownPolicy', () => {
  const policy = new CooldownPolicy();
  const now = new Date('2026-09-10T12:00:00Z');

  describe('checkComment', () => {
    it('allows comment when there is no prior engagement history', () => {
      const result = policy.checkComment(PROSPECT_A, [], now);
      expect(result.allowed).toBe(true);
    });

    it('blocks comment within 14-day window (e.g. 13 days 23 hours ago)', () => {
      const thirteenDaysAgo = new Date(now.getTime() - (14 * 24 * 60 * 60 * 1000 - 60 * 1000));
      const history = [createHistory(PROSPECT_A, 'COMMENT', thirteenDaysAgo)];
      const result = policy.checkComment(PROSPECT_A, history, now);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Comment cooldown active');
      expect(result.nextAllowedAt).toEqual(new Date(thirteenDaysAgo.getTime() + 14 * 24 * 60 * 60 * 1000));
    });

    it('allows comment at the exact 14-day boundary', () => {
      const exactlyFourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
      const history = [createHistory(PROSPECT_A, 'COMMENT', exactlyFourteenDaysAgo)];
      const result = policy.checkComment(PROSPECT_A, history, now);
      expect(result.allowed).toBe(true);
    });

    it('allows comment past 14 days (e.g. 15 days ago)', () => {
      const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);
      const history = [createHistory(PROSPECT_A, 'COMMENT', fifteenDaysAgo)];
      const result = policy.checkComment(PROSPECT_A, history, now);
      expect(result.allowed).toBe(true);
    });

    it('evaluates based on the newest comment when multiple history records exist', () => {
      const twentyDaysAgo = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
      const history = [
        createHistory(PROSPECT_A, 'COMMENT', twentyDaysAgo, 'old'),
        createHistory(PROSPECT_A, 'COMMENT', twoDaysAgo, 'recent'),
      ];
      const result = policy.checkComment(PROSPECT_A, history, now);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Comment cooldown active');
    });

    it('isolates prospects: comments to prospect B do not block prospect A', () => {
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
      const history = [createHistory(PROSPECT_B, 'COMMENT', twoDaysAgo)];
      const result = policy.checkComment(PROSPECT_A, history, now);
      expect(result.allowed).toBe(true);
    });

    it('isolates action types: a recent LIKE does not block a COMMENT', () => {
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
      const history = [createHistory(PROSPECT_A, 'LIKE', twoDaysAgo)];
      const result = policy.checkComment(PROSPECT_A, history, now);
      expect(result.allowed).toBe(true);
    });

    it('enforces daily comment cap across all prospects', () => {
      const history: EngagementHistory[] = [];
      for (let i = 0; i < 5; i++) {
        history.push(
          createHistory(
            `prospect-${i}`,
            'COMMENT',
            new Date(now.getTime() - i * 60 * 1000),
            `comment-${i}`,
          ),
        );
      }
      const result = policy.checkComment(PROSPECT_A, history, now);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Daily comment cap reached');
    });

    it('does not count comments from previous days toward today comment cap', () => {
      const yesterday = new Date(now.getTime() - 25 * 60 * 60 * 1000);
      const history: EngagementHistory[] = [];
      for (let i = 0; i < 5; i++) {
        history.push(
          createHistory(
            `prospect-${i}`,
            'COMMENT',
            new Date(yesterday.getTime() - i * 60 * 1000),
            `comment-${i}`,
          ),
        );
      }
      const result = policy.checkComment(PROSPECT_A, history, now);
      expect(result.allowed).toBe(true);
    });
  });

  describe('checkLike', () => {
    it('blocks like within 5-day window', () => {
      const fourDaysAgo = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000);
      const history = [createHistory(PROSPECT_A, 'LIKE', fourDaysAgo)];
      const result = policy.checkLike(PROSPECT_A, history, now);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Like cooldown active');
    });

    it('allows like at the exact 5-day boundary', () => {
      const exactlyFiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
      const history = [createHistory(PROSPECT_A, 'LIKE', exactlyFiveDaysAgo)];
      const result = policy.checkLike(PROSPECT_A, history, now);
      expect(result.allowed).toBe(true);
    });

    it('isolates action types: a recent COMMENT does not block a LIKE', () => {
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
      const history = [createHistory(PROSPECT_A, 'COMMENT', twoDaysAgo)];
      const result = policy.checkLike(PROSPECT_A, history, now);
      expect(result.allowed).toBe(true);
    });

    it('enforces daily like cap across all prospects', () => {
      const history: EngagementHistory[] = [];
      for (let i = 0; i < 10; i++) {
        history.push(
          createHistory(
            `prospect-${i}`,
            'LIKE',
            new Date(now.getTime() - i * 60 * 1000),
            `like-${i}`,
          ),
        );
      }
      const result = policy.checkLike(PROSPECT_A, history, now);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Daily like cap reached');
    });
  });
});
