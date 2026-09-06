export interface VisitInput {
  profileUrl: string;
  scheduledActionId: string;
}

export interface LikeInput {
  postUrl: string;
  scheduledActionId:string;
}

export interface CommentInput {
  postUrl: string;
  comment: string;
  scheduledActionId: string;
}

export interface ConnectionInput {
  profileUrl: string;
  note?: string;
  scheduledActionId: string;
}

export interface MessageInput {
  profileUrl: string;
  message: string;
  scheduledActionId: string;
}

export interface ReplyCheckInput {
  profileUrl: string;
  scheduledActionId: string;
}

export interface ActionResult {
  success: boolean;
  outcomeLabel?: 'pending' | 'simulated' | 'manual-confirmed' | 'browser-executed' | 'verified' | 'uncertain' | 'refused' | 'failed';
  errorCode?: string;
  timestamp: string;
  audit: {
    eventId: string;
    payloadHash: string;
  };
}

export interface ReplyResult extends ActionResult {
  hasReplied: boolean;
  replyText?: string;
}

export interface LinkedInExecutor {
  visitProfile(input: VisitInput): Promise<ActionResult>;
  likePost(input: LikeInput): Promise<ActionResult>;
  publishComment(input: CommentInput): Promise<ActionResult>;
  sendConnection(input: ConnectionInput): Promise<ActionResult>;
  sendMessage(input: MessageInput): Promise<ActionResult>;
  checkReplies(input: ReplyCheckInput): Promise<ReplyResult>;
}
