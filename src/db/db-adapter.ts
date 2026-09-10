
import {
  Prospect,
  IcpEvaluation,
  ImportBatch,
  IcpDefinition,
  ProspectStage,
  ReviewDecision,
  AuditEvent,
  Campaign,
  ScheduledAction,
} from '../types.js';

export interface DBAdapter {
    insertProspect(prospect: Omit<Prospect, 'id' | 'createdAt' | 'updatedAt' | 'currentStage'>): Promise<Prospect>;
    updateProspectStage(prospectId: string, stage: ProspectStage): Promise<Prospect | undefined>;
    insertIcpEvaluation(evaluation: Omit<IcpEvaluation, 'id' | 'createdAt'>): Promise<IcpEvaluation>;
    insertImportBatch(batch: Omit<ImportBatch, 'id' | 'createdAt' | 'updatedAt' | 'processedRows' | 'qualifiedCount' | 'rejectedCount' | 'reviewCount' | 'status'>): Promise<ImportBatch>;
    updateImportBatch(batchId: string, updates: Partial<ImportBatch>): Promise<ImportBatch | undefined>;
    findIcpDefinitionById(icpDefinitionId: string): Promise<IcpDefinition | undefined>;
    findProspectByTenantAndUrl(tenantId: string, normalizedLinkedinUrl: string): Promise<Prospect | undefined>;
    updateProspect(prospectId: string, prospect: Partial<Omit<Prospect, 'id' | 'tenantId' | 'normalizedLinkedinUrl'>>): Promise<Prospect | undefined>;
    applyOverride(tenantId: string, prospectId: string, newStage: ProspectStage): Promise<void>;
    exportReadyProspects(tenantId: string): Promise<any[]>;
    insertReviewDecision(decision: Omit<ReviewDecision, 'id' | 'createdAt'>): Promise<ReviewDecision>;
    insertAuditEvent(event: Omit<AuditEvent, 'id' | 'createdAt'>): Promise<AuditEvent>;
    getAuditEvents?(tenantId: string): Promise<AuditEvent[]>;
    insertCampaign?(campaign: Omit<Campaign, 'id' | 'createdAt' | 'updatedAt'>): Promise<Campaign>;
    insertScheduledAction(action: Omit<ScheduledAction, 'id' | 'createdAt' | 'updatedAt' | 'status'>): Promise<ScheduledAction>;
    claimNextScheduledAction(tenantId: string, accountId: string, workerId: string, claimToken?: string): Promise<ScheduledAction | undefined>;
    updateScheduledActionStatus(actionId: string, status: ScheduledAction['status']): Promise<ScheduledAction | undefined>;
    createManualTask(task: { tenantId: string; scheduledActionId: string; actionType: 'LIKE' | 'COMMENT' }): Promise<{ id: string; status: 'PENDING_CONFIRMATION' }>;
    completeManualTask(tenantId: string, taskId: string, outcome: 'COMPLETED' | 'FAILED' | 'UNCERTAIN', operatorId: string, metadata?: Record<string, unknown>): Promise<{ status: string; outcomeLabel?: 'manual-confirmed' | 'uncertain' }>;
    updateScheduledActionResult(tenantId: string, actionId: string, result: { status: ScheduledAction['status']; outcomeLabel?: ScheduledAction['outcomeLabel']; errorCode?: string }): Promise<ScheduledAction | undefined>;
    /** Atomically transitions an action and its owned comment slot, when present. */
    finalizeCommentAction(tenantId: string, actionId: string, result: { status: ScheduledAction['status']; outcomeLabel?: ScheduledAction['outcomeLabel']; errorCode?: string }, operatorId?: string): Promise<ScheduledAction | undefined>;
    finalizeEngagementAction?(tenantId: string, actionId: string, result: { status: ScheduledAction['status']; outcomeLabel?: ScheduledAction['outcomeLabel']; errorCode?: string }, operatorId?: string): Promise<ScheduledAction | undefined>;
    checkEngagementCooldown?(tenantId: string, prospectId: string, actionType: 'like' | 'comment', now?: Date): Promise<{ allowed: boolean; reason?: string; nextAllowedAt?: Date }>;
    isCommentSlotOwner(tenantId: string, accountId: string, actionId: string, canonicalPostIdentifier?: string): Promise<boolean>;
    recoverStaleClaims?(ttlMs?: number, tenantId?: string, accountId?: string): Promise<number>;
}

