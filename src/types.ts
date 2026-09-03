
export const DEFAULT_OPERATOR_ID = '00000000-0000-0000-0000-000000000001';

export type CandidateQualificationStatus =
  | 'PENDING'
  | 'QUALIFIED'
  | 'REQUIRES_REVIEW'
  | 'REJECTED'
  | 'FILTERED_OUT';

export type CampaignReadiness =
  | 'NOT_READY'
  | 'READY_FOR_CAMPAIGN'
  | 'APPROVED_FOR_OUTREACH';

export type ProspectStage =
  | 'INGESTED'
  | 'FILTERED_OUT'
  | 'EVALUATED'
  | 'REQUIRES_REVIEW'
  | 'READY_FOR_CAMPAIGN'
  | 'APPROVED_FOR_OUTREACH'
  | 'REJECTED';

export type Prospect = {
  id: string;
  tenantId: string;
  linkedinUrl: string;
  normalizedLinkedinUrl: string;
  currentStage: ProspectStage;
  customAttributes: any;
  createdAt: Date;
  updatedAt: Date;
};

export type Candidate = Prospect;

export type DailyActionBudget = {
  id: string;
  tenantId: string;
  accountId: string;
  actionType: string;
  budgetDate: Date;
  limit: number;
  reservedCount: number;
  completedCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type BudgetReservation = {
  id: string;
  tenantId: string;
  accountId: string;
  actionType: string;
  budgetDate: Date;
  status: 'RESERVED' | 'COMMITTED' | 'RELEASED';
  createdAt: Date;
  updatedAt: Date;
};

export type AccountLease = {
  id: string;
  tenantId: string;
  accountId: string;
  workerId: string;
  leaseToken: string;
  expiresAt: Date;
  heartbeatAt?: Date;
  createdAt: Date;
};

export type IcpDefinition = {
  id: string;
  tenantId: string;
  name: string;
  criteria: any;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type RecruitmentRole = IcpDefinition;

export type ImportBatch = {
  id: string;
  tenantId: string;
  icpDefinitionId: string | null;
  filename: string;
  totalRows: number;
  processedRows: number;
  qualifiedCount: number;
  rejectedCount: number;
  reviewCount: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
};

export type IcpEvaluation = {
  id: string;
  tenantId: string;
  prospectId: string | null;
  icpDefinitionId: string | null;
  importBatchId: string | null;
  score: number | null;
  confidence: number | null;
  fitBreakdown: any;
  evidence: string | null;
  reasoning: string | null;
  status: string;
  evaluatedBy: string | null;
  createdAt: Date;
};

export type CandidateEvaluation = IcpEvaluation;

export type ReviewDecision = {
  id: string;
  tenantId: string;
  prospectId: string;
  decision: 'APPROVED' | 'REJECTED';
  reason: string;
  operatorId: string;
  createdAt: Date;
};

export type AuditEvent = {
  id: string;
  tenantId: string;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  createdAt: Date;
};

export type Campaign = {
  id: string;
  tenantId: string;
  name: string;
  roleId?: string;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  createdAt: Date;
  updatedAt: Date;
};

export type SequenceDefinition = {
  id: string;
  campaignId: string;
  stepOrder: number;
  actionType: string;
  delayDays: number;
  template?: string;
  createdAt: Date;
};

export type CampaignEnrollment = {
  id: string;
  campaignId: string;
  prospectId: string;
  currentStep: number;
  status: 'ENROLLED' | 'IN_PROGRESS' | 'COMPLETED' | 'PAUSED';
  createdAt: Date;
  updatedAt: Date;
};

export type ScheduledAction = {
  id: string;
  tenantId: string;
  campaignEnrollmentId?: string;
  prospectId: string;
  accountId: string;
  actionType: 'visit' | 'like' | 'comment' | 'connection' | 'message' | 'replyCheck';
  payload?: Record<string, unknown>;
  scheduledFor: Date;
  status: 'PENDING' | 'CLAIMED' | 'COMPLETED' | 'FAILED' | 'UNCERTAIN';
  idempotencyKey: string;
  claimedBy?: string;
  claimedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

