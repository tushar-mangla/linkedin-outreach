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

export interface ManualTask {
  taskId: string;
  type: 'visit' | 'like' | 'comment' | 'connection' | 'message' | 'replyCheck';
  description: string;
  copyText: string;
  timestamp: string;
}

// In-memory queue for manual tasks
export const manualTaskQueue: ManualTask[] = [];

export class ManualExecutor implements LinkedInExecutor {
  private async createTask(
    type: ManualTask['type'],
    description: string,
    copyText: string,
    details: any
  ): Promise<ActionResult> {
    const timestamp = new Date().toISOString();
    const taskId = `task_${timestamp}_${Math.random().toString(36).substring(2, 9)}`;

    const task: ManualTask = {
      taskId,
      type,
      description,
      copyText,
      timestamp,
    };

    manualTaskQueue.push(task);
    console.log(`[ManualExecutor] Created task ${taskId}: ${description}`);

    const { eventId, payloadHash } = await auditLogger.record({
      action: `createManualTask:${type}`,
      actor: 'ManualExecutor',
      details: { ...details, taskId },
    });

    return {
      success: true,
      timestamp,
      audit: {
        eventId,
        payloadHash,
      },
    };
  }

  visitProfile(input: VisitInput): Promise<ActionResult> {
    return this.createTask(
      'visit',
      `Visit LinkedIn profile: ${input.profileUrl}`,
      input.profileUrl,
      input
    );
  }

  likePost(input: LikeInput): Promise<ActionResult> {
    return this.createTask(
      'like',
      `Like LinkedIn post: ${input.postUrl}`,
      input.postUrl,
      input
    );
  }

  publishComment(input: CommentInput): Promise<ActionResult> {
    return this.createTask(
      'comment',
      `Comment on LinkedIn post: ${input.postUrl}`,
      input.comment,
      input
    );
  }

  sendConnection(input: ConnectionInput): Promise<ActionResult> {
    const description = input.note
      ? `Send connection request to ${input.profileUrl} with note.`
      : `Send connection request to ${input.profileUrl}.`;
    const copyText = input.note ?? `Connecting with you on LinkedIn.`;
    return this.createTask('connection', description, copyText, input);
  }

  sendMessage(input: MessageInput): Promise<ActionResult> {
    return this.createTask(
      'message',
      `Send message to ${input.profileUrl}`,
      input.message,
      input
    );
  }

  async checkReplies(input: ReplyCheckInput): Promise<ReplyResult> {
    // For manual mode, we can't know the reply, so we create a task
    // and return a neutral response.
    const result = await this.createTask(
      'replyCheck',
      `Check for replies from ${input.profileUrl}`,
      input.profileUrl,
      input
    );

    return {
      ...result,
      hasReplied: false, // Cannot be determined automatically
    };
  }
}
