
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
  LinkedInPost,
  ProspectBuyingSignal,
  MarketContentInsight,
  DiscoveryQueryStat,
  EngagerTarget,
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
    updateScheduledActionResult(tenantId: string, actionId: string, result: { status: ScheduledAction['status']; outcomeLabel?: ScheduledAction['outcomeLabel']; errorCode?: string; attemptCount?: number; scheduledFor?: Date }): Promise<ScheduledAction | undefined>;
    /** Atomically transitions an action and its owned comment slot, when present. */
    finalizeCommentAction(tenantId: string, actionId: string, result: { status: ScheduledAction['status']; outcomeLabel?: ScheduledAction['outcomeLabel']; errorCode?: string; attemptCount?: number; scheduledFor?: Date }, operatorId?: string): Promise<ScheduledAction | undefined>;
    finalizeEngagementAction?(tenantId: string, actionId: string, result: { status: ScheduledAction['status']; outcomeLabel?: ScheduledAction['outcomeLabel']; errorCode?: string; attemptCount?: number; scheduledFor?: Date }, operatorId?: string): Promise<ScheduledAction | undefined>;
    checkEngagementCooldown?(tenantId: string, prospectId: string, actionType: 'like' | 'comment', now?: Date): Promise<{ allowed: boolean; reason?: string; nextAllowedAt?: Date }>;
    isCommentSlotOwner(tenantId: string, accountId: string, actionId: string, canonicalPostIdentifier?: string): Promise<boolean>;
    recoverStaleClaims?(ttlMs?: number, tenantId?: string, accountId?: string): Promise<number>;
    resumePausedActions?(tenantId?: string): Promise<number>;
    findProspectById(tenantId: string, prospectId: string): Promise<Prospect | undefined>;
    insertEngagementPost(post: Omit<LinkedInPost, 'id' | 'createdAt'>): Promise<LinkedInPost>;
    insertProspectBuyingSignal(signal: Omit<ProspectBuyingSignal, 'id' | 'createdAt'>): Promise<ProspectBuyingSignal>;
    insertMarketContentInsight(insight: Omit<MarketContentInsight, 'id' | 'createdAt'>): Promise<MarketContentInsight>;
    upsertDiscoveryQueryStat(stat: { tenantId: string; query: string; postsFound?: number; signalsDetected?: number }): Promise<DiscoveryQueryStat>;
    findBuyingSignalsByTenant(tenantId: string): Promise<ProspectBuyingSignal[]>;
    findContentInsightsByTenant(tenantId: string): Promise<MarketContentInsight[]>;
    findQueryStatsByTenant(tenantId: string): Promise<DiscoveryQueryStat[]>;
    incrementQueryStatPromoted(tenantId: string, query: string): Promise<void>;
    // ─── Channel 5: target registry ───
    listEngagerTargets(tenantId: string, opts?: { activeOnly?: boolean }): Promise<EngagerTarget[]>;
    /** Idempotent seed insert: creates the target only when (tenantId, normalizedUrl) is absent. */
    upsertEngagerTarget(target: Omit<EngagerTarget, 'id' | 'createdAt' | 'updatedAt' | 'isActive'> & { isActive?: boolean }): Promise<EngagerTarget>;
    updateEngagerTargetActive(tenantId: string, targetId: string, isActive: boolean): Promise<EngagerTarget | undefined>;
    findEngagerTargetById(tenantId: string, targetId: string): Promise<EngagerTarget | undefined>;
}

