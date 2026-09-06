import type { CommentDraft } from '../../types.js';

// ─── EngagementAIProvider interface ──────────────────────────────────────────

export interface GenerateCommentInput {
  postText: string;
  authorName: string;
  prospectLinkedInUrl: string;
  /** Recruiter's own voice/persona description (passed in prompt) */
  voiceProfile?: string;
}

/**
 * Separate from ICPModelProvider. This provider is only responsible for
 * generating contextual comment drafts grounded in a LinkedIn post's text.
 */
export interface EngagementAIProvider {
  generateComment(input: GenerateCommentInput): Promise<CommentDraft>;
  readonly providerName: 'luna' | 'fake';
}
