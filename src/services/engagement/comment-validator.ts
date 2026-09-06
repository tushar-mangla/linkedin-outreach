// ─── CommentValidator ─────────────────────────────────────────────────────────
//
// Rejects AI-generated comments that are:
//   - Too short (< 15 words) or too long (> 60 words)
//   - Generic / hype-y (banned opening phrases)
//   - Not grounded in any specific part of the post text

const BANNED_OPENERS = [
  'great post',
  'love this',
  'congrats',
  'congratulations',
  'so true',
  'totally agree',
  'well said',
  'amazing',
  'fantastic',
  'wonderful',
  'insightful',
  'this is awesome',
  'this is great',
  'thanks for sharing',
  'thank you for sharing',
  'thanks for posting',
];

export interface ValidationResult {
  valid: boolean;
  reasons: string[];
}

export class CommentValidator {
  private readonly minWords: number;
  private readonly maxWords: number;

  constructor(opts: { minWords?: number; maxWords?: number } = {}) {
    this.minWords = opts.minWords ?? 15;
    this.maxWords = opts.maxWords ?? 60;
  }

  validate(commentText: string, postText: string): ValidationResult {
    const reasons: string[] = [];
    const trimmed = commentText.trim();
    const words = trimmed.split(/\s+/).filter(Boolean);

    if (words.length < this.minWords) {
      reasons.push(`Too short: ${words.length} words (minimum ${this.minWords})`);
    }

    if (words.length > this.maxWords) {
      reasons.push(`Too long: ${words.length} words (maximum ${this.maxWords})`);
    }

    const lower = trimmed.toLowerCase();
    for (const banned of BANNED_OPENERS) {
      if (lower.startsWith(banned) || lower.includes(`! ${banned}`) || lower === banned) {
        reasons.push(`Contains generic/banned phrase: "${banned}"`);
        break;
      }
    }

    // Groundedness check: at least one content word from the post must appear in the comment
    if (!this.isGrounded(trimmed, postText)) {
      reasons.push('Comment does not reference any specific content from the post');
    }

    return { valid: reasons.length === 0, reasons };
  }

  private isGrounded(comment: string, postText: string): boolean {
    // Extract meaningful words from post (≥ 5 chars, not stop words)
    const stopWords = new Set(['about', 'after', 'again', 'being', 'every', 'their', 'there', 'these', 'those', 'which', 'while', 'would']);
    const postWords = postText
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length >= 5 && !stopWords.has(w));

    const commentLower = comment.toLowerCase();
    return postWords.some((w) => commentLower.includes(w));
  }
}
