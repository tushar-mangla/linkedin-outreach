import {
  LinkedInExecutor,
  VisitInput,
  LikeInput,
  CommentInput,
  ConnectionInput,
  MessageInput,
  ReplyCheckInput,
  ActionResult,
  ReplyResult,
} from './types.js';
import { auditLogger } from '../lib/audit.js';

// In-memory store for fake data
const fakeDb = {
  profiles: new Map<string, { visited?: boolean; connectionSent?: boolean; messages: string[] }>(),
  posts: new Map<string, { liked?: boolean; comments: string[] }>(),
  replies: new Map<string, { hasReplied: boolean; replyText?: string }>(),
};

export class FakeExecutor implements LinkedInExecutor {
  private async createSuccessResult(action: string, details: any): Promise<ActionResult> {
    const { eventId, payloadHash } = await auditLogger.record({
      action,
      actor: 'FakeExecutor',
      details,
    });
    return {
      success: true,
      timestamp: new Date().toISOString(),
      audit: {
        eventId,
        payloadHash,
      },
    };
  }

  async visitProfile(input: VisitInput): Promise<ActionResult> {
    console.log(`[FakeExecutor] Visiting profile: ${input.profileUrl}`);
    const profile = fakeDb.profiles.get(input.profileUrl) ?? { messages: [] };
    profile.visited = true;
    fakeDb.profiles.set(input.profileUrl, profile);
    return this.createSuccessResult('visitProfile', input);
  }

  async likePost(input: LikeInput): Promise<ActionResult> {
    console.log(`[FakeExecutor] Liking post: ${input.postUrl}`);
    const post = fakeDb.posts.get(input.postUrl) ?? { comments: [] };
    post.liked = true;
    fakeDb.posts.set(input.postUrl, post);
    return this.createSuccessResult('likePost', input);
  }

  async publishComment(input: CommentInput): Promise<ActionResult> {
    console.log(`[FakeExecutor] Publishing comment on: ${input.postUrl}`);
    const post = fakeDb.posts.get(input.postUrl) ?? { comments: [] };
    post.comments.push(input.comment);
    fakeDb.posts.set(input.postUrl, post);
    return this.createSuccessResult('publishComment', input);
  }

  async sendConnection(input: ConnectionInput): Promise<ActionResult> {
    console.log(`[FakeExecutor] Sending connection to: ${input.profileUrl}`);
    const profile = fakeDb.profiles.get(input.profileUrl) ?? { messages: [] };
    profile.connectionSent = true;
    fakeDb.profiles.set(input.profileUrl, profile);
    return this.createSuccessResult('sendConnection', input);
  }

  async sendMessage(input: MessageInput): Promise<ActionResult> {
    console.log(`[FakeExecutor] Sending message to: ${input.profileUrl}`);
    const profile = fakeDb.profiles.get(input.profileUrl) ?? { messages: [] };
    profile.messages.push(input.message);
    fakeDb.profiles.set(input.profileUrl, profile);
    return this.createSuccessResult('sendMessage', input);
  }

  async checkReplies(input: ReplyCheckInput): Promise<ReplyResult> {
    console.log(`[FakeExecutor] Checking replies for: ${input.profileUrl}`);
    const reply = fakeDb.replies.get(input.profileUrl) ?? { hasReplied: false };
    const { eventId, payloadHash } = await auditLogger.record({
      action: 'checkReplies',
      actor: 'FakeExecutor',
      details: { ...input, result: reply },
    });

    return {
      ...reply,
      success: true,
      timestamp: new Date().toISOString(),
      audit: {
        eventId,
        payloadHash,
      },
    };
  }
}
