
import { randomUUID } from 'node:crypto';
import { and, eq, gte, lt, sql, lte } from 'drizzle-orm';
import { PgliteDatabase } from 'drizzle-orm/pglite';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Prospect, IcpEvaluation, ImportBatch, IcpDefinition, ProspectStage, ReviewDecision, AuditEvent, DEFAULT_OPERATOR_ID, LinkedInPost, ProspectBuyingSignal, MarketContentInsight, DiscoveryQueryStat, EngagerTarget } from '../types.js';
import { DBAdapter } from './db-adapter.js';
import { BudgetStorageAdapter } from '../services/budget-storage-adapter.js';
import { LeaseStorageAdapter } from '../services/lease-storage-adapter.js';
import { CooldownPolicy } from '../services/engagement/cooldown-policy.js';
import * as schema from './schema.js';
import { assertTenantId, requireTenantId } from './tenant-context.js';
import { withDbRetry } from './retry.js';
import { dailyActionBudgets, budgetReservations, prospects, icpEvaluations, importBatches, icpDefinitions, accountLeases, reviewDecisions, auditEvents, scheduledActions, manualTasks, accountPostComments, engagementHistory, engagementPosts, engagementDrafts, recommendationRevisions, prospectBuyingSignals, marketContentInsights, discoveryQueryStats, engagementTargetSources } from './schema.js';


export const TERMINAL_SCHEDULED_ACTION_STATUSES: ReadonlyArray<string> = ['COMPLETED', 'FAILED', 'CANCELLED', 'UNCERTAIN'];

export class DrizzleAdapter implements DBAdapter, BudgetStorageAdapter, LeaseStorageAdapter {
    private db: NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

    constructor(db: NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>) {
        this.db = db;
    }

    // --- Prospect Methods ---
    async insertProspect(prospectData: Omit<Prospect, 'id' | 'createdAt' | 'updatedAt' | 'currentStage'>): Promise<Prospect> {
        assertTenantId(prospectData.tenantId);
        const result = await this.db.insert(prospects).values(prospectData).returning();
        return result[0];
    }

    async updateProspectStage(prospectId: string, stage: ProspectStage): Promise<Prospect | undefined> {
        const result = await this.db.update(prospects).set({ currentStage: stage, updatedAt: new Date() }).where(and(eq(prospects.id, prospectId), eq(prospects.tenantId, requireTenantId()))).returning();
        return result[0];
    }

    async findProspectByTenantAndUrl(tenantId: string, normalizedLinkedinUrl: string): Promise<Prospect | undefined> {
        assertTenantId(tenantId);
        return this.db.query.prospects.findFirst({
            where: and(
                eq(prospects.tenantId, tenantId),
                eq(prospects.normalizedLinkedinUrl, normalizedLinkedinUrl)
            )
        });
    }

    async updateProspect(prospectId: string, prospectData: Partial<Omit<Prospect, 'id' | 'tenantId' | 'normalizedLinkedinUrl'>>): Promise<Prospect | undefined> {
        const result = await this.db.update(prospects).set({ ...prospectData, updatedAt: new Date() }).where(and(eq(prospects.id, prospectId), eq(prospects.tenantId, requireTenantId()))).returning();
        return result[0];
    }

    // --- ICP Evaluation Methods ---
    async insertIcpEvaluation(evaluation: Omit<IcpEvaluation, 'id' | 'createdAt'>): Promise<IcpEvaluation> {
        assertTenantId(evaluation.tenantId);
        const result = await this.db.insert(icpEvaluations).values(evaluation).returning();
        return result[0];
    }

    // --- Import Batch Methods ---
    async insertImportBatch(batchData: Omit<ImportBatch, 'id' | 'createdAt' | 'updatedAt' | 'processedRows' | 'qualifiedCount' | 'rejectedCount' | 'reviewCount' | 'status'>): Promise<ImportBatch> {
        assertTenantId(batchData.tenantId);
        const result = await this.db.insert(importBatches).values({
            ...batchData,
            status: 'PROCESSING',
        }).returning();
        return result[0];
    }

    async updateImportBatch(batchId: string, updates: Partial<ImportBatch>): Promise<ImportBatch | undefined> {
        const result = await this.db.update(importBatches).set({ ...updates, updatedAt: new Date() }).where(and(eq(importBatches.id, batchId), eq(importBatches.tenantId, requireTenantId()))).returning();
        return result[0];
    }

    // --- ICP Definition Methods ---
    async findIcpDefinitionById(icpDefinitionId: string): Promise<IcpDefinition | undefined> {
        return this.db.query.icpDefinitions.findFirst({ where: and(eq(icpDefinitions.id, icpDefinitionId), eq(icpDefinitions.tenantId, requireTenantId())) });
    }

    // --- Budget Service Methods ---
    async reserveBudget(tenantId: string, accountId: string, actionType: string, budgetDate: Date): Promise<string | undefined> {
        assertTenantId(tenantId);
        const result = await this.db.update(dailyActionBudgets)
            .set({ reservedCount: sql`${dailyActionBudgets.reservedCount} + 1` })
            .where(and(
                eq(dailyActionBudgets.tenantId, tenantId),
                eq(dailyActionBudgets.accountId, accountId),
                eq(dailyActionBudgets.actionType, actionType),
                eq(dailyActionBudgets.budgetDate, budgetDate),
                lt(sql`${dailyActionBudgets.reservedCount} + ${dailyActionBudgets.completedCount}`, dailyActionBudgets.limit)
            ));
        if ((result.rowCount ?? 0) === 0) {
            return undefined;
        }

        const reservation = await this.db.insert(budgetReservations).values({
            tenantId,
            accountId,
            actionType,
            budgetDate,
            status: 'RESERVED',
        }).returning();
        return reservation[0]?.id;
    }

    async commitAction(reservationId: string): Promise<void> {
        const reservation = await this.db.query.budgetReservations.findFirst({
            where: and(eq(budgetReservations.id, reservationId), eq(budgetReservations.status, 'RESERVED')),
        });
        if (!reservation) return;
        await this.db.update(dailyActionBudgets)
            .set({
                reservedCount: sql`${dailyActionBudgets.reservedCount} - 1`,
                completedCount: sql`${dailyActionBudgets.completedCount} + 1`
            })
            .where(and(
                eq(dailyActionBudgets.tenantId, reservation.tenantId),
                eq(dailyActionBudgets.accountId, reservation.accountId),
                eq(dailyActionBudgets.actionType, reservation.actionType),
                eq(dailyActionBudgets.budgetDate, reservation.budgetDate),
                gte(dailyActionBudgets.reservedCount, 1)
            ));
        await this.db.update(budgetReservations)
            .set({ status: 'COMMITTED', updatedAt: new Date() })
            .where(and(eq(budgetReservations.id, reservationId), eq(budgetReservations.status, 'RESERVED')));
    }

    async releaseBudget(reservationId: string): Promise<void> {
        const reservation = await this.db.query.budgetReservations.findFirst({
            where: and(eq(budgetReservations.id, reservationId), eq(budgetReservations.status, 'RESERVED')),
        });
        if (!reservation) return;
        await this.db.update(dailyActionBudgets)
            .set({ reservedCount: sql`${dailyActionBudgets.reservedCount} - 1` })
            .where(and(
                eq(dailyActionBudgets.tenantId, reservation.tenantId),
                eq(dailyActionBudgets.accountId, reservation.accountId),
                eq(dailyActionBudgets.actionType, reservation.actionType),
                eq(dailyActionBudgets.budgetDate, reservation.budgetDate),
                gte(dailyActionBudgets.reservedCount, 1)
            ));
        await this.db.update(budgetReservations)
            .set({ status: 'RELEASED', updatedAt: new Date() })
            .where(and(eq(budgetReservations.id, reservationId), eq(budgetReservations.status, 'RESERVED')));
    }

    // --- Lease Service Methods ---
    async acquireLease(tenantId: string, accountId: string, workerId: string, ttlSeconds: number, leaseToken?: string): Promise<boolean> {
        assertTenantId(tenantId);
        const { randomUUID } = await import('node:crypto');
        const token = leaseToken ?? randomUUID();
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
        await this.recoverExpiredLeases(tenantId);
        try {
            await this.db.insert(accountLeases).values({
                tenantId,
                accountId,
                workerId,
                leaseToken: token,
                heartbeatAt: new Date(),
                expiresAt,
            });
            return true;
        } catch (error) {
            return false;
        }
    }

    async acquireLeaseToken(tenantId: string, accountId: string, workerId: string, ttlSeconds: number): Promise<string | null> {
        const { randomUUID } = await import('node:crypto');
        const token = randomUUID();
        const acquired = await this.acquireLease(tenantId, accountId, workerId, ttlSeconds, token);
        return acquired ? token : null;
    }

    async heartbeatLease(tenantId: string, accountId: string, workerId: string, token: string, ttlSeconds: number): Promise<boolean> {
        assertTenantId(tenantId);
        const rows = await this.db.update(accountLeases)
            .set({ heartbeatAt: new Date(), expiresAt: new Date(Date.now() + ttlSeconds * 1000) })
            .where(and(
                eq(accountLeases.tenantId, tenantId),
                eq(accountLeases.accountId, accountId),
                eq(accountLeases.workerId, workerId),
                eq(accountLeases.leaseToken, token),
                sql`${accountLeases.expiresAt} > now()`,
            )).returning();
        return (rows.length ?? 0) > 0;
    }

    async getActiveLease(tenantId: string, accountId: string) {
        assertTenantId(tenantId);
        return this.db.query.accountLeases.findFirst({
            where: and(eq(accountLeases.tenantId, tenantId), eq(accountLeases.accountId, accountId), sql`${accountLeases.expiresAt} > now()`),
        }) as Promise<import('../types.js').AccountLease | undefined>;
    }

    async releaseLease(tenantId: string, accountId: string, workerId: string, leaseToken?: string): Promise<void> {
        assertTenantId(tenantId);
        const conditions = [
            eq(accountLeases.tenantId, tenantId),
            eq(accountLeases.accountId, accountId),
            eq(accountLeases.workerId, workerId),
        ];
        if (leaseToken) conditions.push(eq(accountLeases.leaseToken, leaseToken));
        await this.db.delete(accountLeases).where(and(...conditions));
    }

    async recoverExpiredLeases(tenantId: string): Promise<void> {
        assertTenantId(tenantId);
        await this.db.delete(accountLeases).where(and(
            eq(accountLeases.tenantId, tenantId),
            lte(accountLeases.expiresAt, new Date())
        ));
    }

    async applyOverride(tenantId: string, prospectId: string, newStage: ProspectStage): Promise<void> {
        assertTenantId(tenantId);
        await this.db.update(prospects).set({ currentStage: newStage }).where(and(
            eq(prospects.tenantId, tenantId),
            eq(prospects.id, prospectId)
        ));
    }

    async exportReadyProspects(tenantId: string): Promise<any[]> {
        assertTenantId(tenantId);
        return this.db.select().from(prospects).where(and(
            eq(prospects.tenantId, tenantId),
            eq(prospects.currentStage, 'READY_FOR_CAMPAIGN')
        ));
    }

    async insertReviewDecision(decision: Omit<ReviewDecision, 'id' | 'createdAt'>): Promise<ReviewDecision> {
        assertTenantId(decision.tenantId);
        const result = await this.db.insert(reviewDecisions).values(decision).returning();
        return result[0] as ReviewDecision;
    }

    async insertAuditEvent(event: Omit<AuditEvent, 'id' | 'createdAt'>): Promise<AuditEvent> {
        assertTenantId(event.tenantId);
        const result = await this.db.insert(auditEvents).values(event).returning();
        return result[0] as AuditEvent;
    }

    async insertScheduledAction(action: Omit<import('../types.js').ScheduledAction, 'id' | 'createdAt' | 'updatedAt' | 'status'>) {
        assertTenantId(action.tenantId);
        const result = await this.db.insert(scheduledActions).values({ ...action, actionType: action.actionType }).onConflictDoNothing().returning();
        if (!result[0]) {
            const existing = await this.db.query.scheduledActions.findFirst({ where: and(eq(scheduledActions.tenantId, action.tenantId), eq(scheduledActions.idempotencyKey, action.idempotencyKey)) });
            if (!existing) throw new Error('ACTION_DUPLICATE');
            return existing as import('../types.js').ScheduledAction;
        }
        return result[0] as import('../types.js').ScheduledAction;
    }

    async recoverStaleClaims(ttlMs: number = 15 * 60 * 1000, tenantId?: string, accountId?: string): Promise<number> {
        const intervalSeconds = Math.max(1, Math.floor(ttlMs / 1000));
        return withDbRetry(async () => {
            const tenantFilter = tenantId ? sql`AND a."tenant_id" = ${tenantId}::uuid` : sql``;
            const accountFilter = accountId ? sql`AND a."account_id" = ${accountId}::uuid` : sql``;

            const recovered = await this.db.execute(sql`
                UPDATE "scheduled_actions" AS a
                SET
                    "status" = 'PENDING',
                    "claimed_by" = NULL,
                    "claimed_at" = NULL,
                    "claim_token" = NULL,
                    "error_code" = 'DB_TRANSIENT',
                    "updated_at" = now()
                WHERE a."status" = 'CLAIMED'
                  AND COALESCE(a."claimed_at", a."updated_at") < now() - (${intervalSeconds} || ' seconds')::interval
                  ${tenantFilter}
                  ${accountFilter}
                  AND NOT EXISTS (
                      SELECT 1 FROM "account_leases" AS l
                      WHERE l."tenant_id" = a."tenant_id"
                        AND l."account_id" = a."account_id"
                        AND l."expires_at" > now()
                  )
                RETURNING a."id";
            `);
            const rows = (recovered as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
            return rows.length;
        });
    }

    async resumePausedActions(tenantId?: string): Promise<number> {
        return withDbRetry(async () => {
            const tenantFilter = tenantId ? sql`AND "tenant_id" = ${tenantId}::uuid` : sql``;
            const resumed = await this.db.execute(sql`
                UPDATE "scheduled_actions"
                SET
                    "status" = 'PENDING',
                    "error_code" = NULL,
                    "updated_at" = now()
                WHERE "status" = 'PAUSED_BUDGET'
                  AND "scheduled_for" <= now()
                  ${tenantFilter}
                RETURNING "id";
            `);
            const rows = (resumed as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
            return rows.length;
        });
    }

    async claimNextScheduledAction(tenantId: string, accountId: string, workerId: string, claimToken?: string) {
        assertTenantId(tenantId);
        const { randomUUID } = await import('node:crypto');
        const token = claimToken ?? randomUUID();
        return withDbRetry(async () => {
            // Atomic tenant-bound claim: single UPDATE over the oldest PENDING row.
            // PostgreSQL runtime uses FOR UPDATE SKIP LOCKED semantics via row-level
            // locking; the subselect orders deterministically so concurrent workers
            // never claim the same row.
            const claimed = await this.db.execute(sql`
                UPDATE "scheduled_actions" AS action SET
                    "status" = 'CLAIMED',
                    "claimed_by" = ${workerId},
                    "claimed_at" = now(),
                    "claim_token" = ${token},
                    "updated_at" = now()
                WHERE "id" = (
                    SELECT "id" FROM "scheduled_actions"
                    WHERE "tenant_id" = ${tenantId}::uuid
                      AND "account_id" = ${accountId}::uuid
                      AND "status" = 'PENDING'
                      AND "scheduled_for" <= now()
                    ORDER BY "scheduled_for" ASC, "created_at" ASC
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                )
                RETURNING *;
            `);
            const rows = (claimed as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [];
            if (rows.length === 0) return undefined;
            const row = rows[0] as Record<string, unknown>;
            return {
                id: row.id as string,
                tenantId: row.tenant_id as string,
                campaignEnrollmentId: (row.campaign_enrollment_id as string) ?? undefined,
                prospectId: row.prospect_id as string,
                accountId: row.account_id as string,
                actionType: row.action_type as import('../types.js').ScheduledAction['actionType'],
                payload: (row.payload as Record<string, unknown>) ?? undefined,
                scheduledFor: new Date(row.scheduled_for as string),
                status: row.status as import('../types.js').ScheduledAction['status'],
                idempotencyKey: row.idempotency_key as string,
                claimToken: (row.claim_token as string) ?? token,
                revisionId: (row.revision_id as string) ?? undefined,
                postHash: (row.post_hash as string) ?? undefined,
                mode: (row.mode as import('../types.js').ScheduledAction['mode']) ?? undefined,
                outcomeLabel: (row.outcome_label as import('../types.js').ScheduledAction['outcomeLabel']) ?? undefined,
                errorCode: (row.error_code as string) ?? undefined,
                attemptCount: (row.attempt_count as number) ?? 0,
                claimedBy: (row.claimed_by as string) ?? undefined,
                claimedAt: row.claimed_at ? new Date(row.claimed_at as string) : undefined,
                completedAt: row.completed_at ? new Date(row.completed_at as string) : undefined,
                createdAt: new Date(row.created_at as string),
                updatedAt: new Date(row.updated_at as string),
            } as import('../types.js').ScheduledAction;
        });
    }

    async updateScheduledActionStatus(actionId: string, status: import('../types.js').ScheduledAction['status']) {
        const tenantId = requireTenantId();
        return withDbRetry(async () => {
            const current = await this.db.query.scheduledActions.findFirst({ where: and(eq(scheduledActions.id, actionId), eq(scheduledActions.tenantId, tenantId)) });
            if (!current) return undefined;
            if (TERMINAL_SCHEDULED_ACTION_STATUSES.includes(current.status)) {
                throw new Error('TERMINAL_STATE_IMMUTABLE');
            }
            const rows = await this.db.update(scheduledActions).set({ status, updatedAt: new Date(), completedAt: TERMINAL_SCHEDULED_ACTION_STATUSES.includes(status) ? new Date() : current.completedAt }).where(and(eq(scheduledActions.id, actionId), eq(scheduledActions.tenantId, tenantId))).returning();
            return rows[0] as import('../types.js').ScheduledAction | undefined;
        });
    }

    async updateScheduledActionResult(tenantId: string, actionId: string, result: { status: import('../types.js').ScheduledAction['status']; outcomeLabel?: import('../types.js').ScheduledAction['outcomeLabel']; errorCode?: string; attemptCount?: number; scheduledFor?: Date }) {
        assertTenantId(tenantId);
        return withDbRetry(async () => {
            const current = await this.db.query.scheduledActions.findFirst({ where: and(eq(scheduledActions.id, actionId), eq(scheduledActions.tenantId, tenantId)) });
            if (!current) return undefined;
            if (TERMINAL_SCHEDULED_ACTION_STATUSES.includes(current.status)) {
                throw new Error('TERMINAL_STATE_IMMUTABLE');
            }
            const setValues: any = {
                status: result.status,
                outcomeLabel: result.outcomeLabel,
                errorCode: result.errorCode,
                updatedAt: new Date(),
            };
            if (result.attemptCount !== undefined) setValues.attemptCount = result.attemptCount;
            if (result.scheduledFor !== undefined) setValues.scheduledFor = result.scheduledFor;
            if (TERMINAL_SCHEDULED_ACTION_STATUSES.includes(result.status)) {
                setValues.completedAt = new Date();
            }
            const rows = await this.db.update(scheduledActions).set(setValues).where(and(eq(scheduledActions.id, actionId), eq(scheduledActions.tenantId, tenantId))).returning();
            return rows[0] as import('../types.js').ScheduledAction | undefined;
        });
    }

    async isCommentSlotOwner(tenantId: string, accountId: string, actionId: string): Promise<boolean> {
        assertTenantId(tenantId);
        const slot = await this.db.query.accountPostComments.findFirst({ where: and(
            eq(accountPostComments.tenantId, tenantId),
            eq(accountPostComments.accountId, accountId),
            eq(accountPostComments.scheduledActionId, actionId),
            eq(accountPostComments.status, 'PENDING'),
        ) });
        return !!slot;
    }

    async finalizeCommentAction(tenantId: string, actionId: string, result: { status: import('../types.js').ScheduledAction['status']; outcomeLabel?: import('../types.js').ScheduledAction['outcomeLabel']; errorCode?: string; attemptCount?: number; scheduledFor?: Date }, operatorId?: string) {
        assertTenantId(tenantId);
        return withDbRetry(async () => {
            return this.db.transaction(async (tx) => {
                const current = await tx.query.scheduledActions.findFirst({ where: and(eq(scheduledActions.id, actionId), eq(scheduledActions.tenantId, tenantId)) });
                if (!current) return undefined;
                if (TERMINAL_SCHEDULED_ACTION_STATUSES.includes(current.status)) {
                    if (current.status === result.status) {
                        return current as import('../types.js').ScheduledAction;
                    }
                    throw new Error('TERMINAL_STATE_IMMUTABLE');
                }
                const terminal = ['COMPLETED', 'FAILED', 'UNCERTAIN'].includes(result.status);
                const setValues: any = { status: result.status, outcomeLabel: result.outcomeLabel, errorCode: result.errorCode, updatedAt: new Date() };
                if (result.attemptCount !== undefined) setValues.attemptCount = result.attemptCount;
                if (result.scheduledFor !== undefined) setValues.scheduledFor = result.scheduledFor;
                if (terminal) setValues.completedAt = new Date();
                const rows = await tx.update(scheduledActions).set(setValues).where(and(eq(scheduledActions.id, actionId), eq(scheduledActions.tenantId, tenantId))).returning();
                if (current.actionType === 'comment' && terminal) {
                    const slotRows = await tx.update(accountPostComments).set({ status: result.status, updatedAt: new Date() }).where(and(
                        eq(accountPostComments.tenantId, tenantId),
                        eq(accountPostComments.accountId, current.accountId),
                        eq(accountPostComments.scheduledActionId, actionId),
                        eq(accountPostComments.status, 'PENDING'),
                    )).returning();
                    if (!slotRows[0]) throw new Error('COMMENT_SLOT_OWNER_REQUIRED');
                }

                // If action completed successfully and is an engagement action (like/comment), insert into engagement_history
                if (result.status === 'COMPLETED' && (current.actionType === 'comment' || current.actionType === 'like')) {
                    let postId: string | undefined;
                    if (current.revisionId) {
                        const revision = await tx.query.recommendationRevisions.findFirst({
                            where: and(
                                eq(recommendationRevisions.id, current.revisionId),
                                eq(recommendationRevisions.tenantId, tenantId),
                            ),
                        });
                        if (revision) {
                            const draft = await tx.query.engagementDrafts.findFirst({
                                where: and(
                                    eq(engagementDrafts.id, revision.draftId),
                                    eq(engagementDrafts.tenantId, tenantId),
                                ),
                            });
                            if (draft) {
                                postId = draft.postId;
                            }
                        }
                    }
                    if (!postId && current.postHash) {
                        const post = await tx.query.engagementPosts.findFirst({
                            where: and(
                                eq(engagementPosts.tenantId, tenantId),
                                eq(engagementPosts.contentHash, current.postHash),
                            ),
                        });
                        if (post) {
                            postId = post.id;
                        }
                    }
                    if (!postId) {
                        const post = await tx.query.engagementPosts.findFirst({
                            where: and(
                                eq(engagementPosts.tenantId, tenantId),
                                eq(engagementPosts.prospectId, current.prospectId),
                            ),
                        });
                        if (post) {
                            postId = post.id;
                        }
                    }
                    if (postId) {
                        await tx.insert(engagementHistory).values({
                            id: randomUUID(),
                            tenantId,
                            prospectId: current.prospectId,
                            postId,
                            actionType: current.actionType.toUpperCase() as 'LIKE' | 'COMMENT',
                            interactedAt: new Date(),
                            operatorId: operatorId ?? current.claimedBy ?? DEFAULT_OPERATOR_ID,
                            scheduledActionId: current.id,
                        }).onConflictDoNothing();
                    }
                }

                return rows[0] as import('../types.js').ScheduledAction | undefined;
            });
        });
    }

    async finalizeEngagementAction(tenantId: string, actionId: string, result: { status: import('../types.js').ScheduledAction['status']; outcomeLabel?: import('../types.js').ScheduledAction['outcomeLabel']; errorCode?: string }, operatorId?: string) {
        return this.finalizeCommentAction(tenantId, actionId, result, operatorId);
    }

    async checkEngagementCooldown(tenantId: string, prospectId: string, actionType: 'like' | 'comment', now?: Date) {
        assertTenantId(tenantId);
        const rows = await this.db.query.engagementHistory.findMany({
            where: and(
                eq(engagementHistory.tenantId, tenantId),
                eq(engagementHistory.prospectId, prospectId),
            ),
        });
        const history: import('../types.js').EngagementHistory[] = rows.map((r) => ({
            id: r.id,
            tenantId: r.tenantId,
            prospectId: r.prospectId,
            postId: r.postId,
            actionType: r.actionType as 'LIKE' | 'COMMENT',
            interactedAt: r.interactedAt,
            operatorId: r.operatorId,
        }));
        const policy = new CooldownPolicy();
        return actionType === 'comment'
            ? policy.checkComment(prospectId, history, now)
            : policy.checkLike(prospectId, history, now);
    }

    async createManualTask(task: { tenantId: string; scheduledActionId: string; actionType: 'LIKE' | 'COMMENT' }) {
        assertTenantId(task.tenantId);
        const result = await this.db.insert(manualTasks).values(task).returning();
        return { id: result[0].id, status: result[0].status as 'PENDING_CONFIRMATION' };
    }

    async completeManualTask(tenantId: string, taskId: string, outcome: 'COMPLETED' | 'FAILED' | 'UNCERTAIN', operatorId: string, metadata?: Record<string, unknown>) {
        assertTenantId(tenantId);
        const rows = await this.db.update(manualTasks).set({ status: outcome, outcomeLabel: outcome === 'COMPLETED' ? 'manual-confirmed' : 'uncertain', confirmationActor: operatorId, confirmationMetadata: metadata ?? {}, completedAt: new Date() }).where(and(eq(manualTasks.id, taskId), eq(manualTasks.tenantId, tenantId), eq(manualTasks.status, 'PENDING_CONFIRMATION'))).returning();
        if (!rows[0]) throw new Error('MANUAL_TASK_TERMINAL');
        if (rows[0].scheduledActionId) {
            await this.finalizeCommentAction(tenantId, rows[0].scheduledActionId, {
                status: outcome === 'COMPLETED' ? 'COMPLETED' : outcome === 'FAILED' ? 'FAILED' : 'UNCERTAIN',
                outcomeLabel: rows[0].outcomeLabel as import('../types.js').ScheduledAction['outcomeLabel'],
            }, operatorId);
        }
        return rows[0] as { status: string; outcomeLabel?: 'manual-confirmed' | 'uncertain' };
    }

    // --- Channel 4: Prospect discovery methods ---

    async findProspectById(tenantId: string, prospectId: string): Promise<Prospect | undefined> {
        assertTenantId(tenantId);
        return this.db.query.prospects.findFirst({
            where: and(eq(prospects.tenantId, tenantId), eq(prospects.id, prospectId)),
        }) as Promise<Prospect | undefined>;
    }

    async insertEngagementPost(post: Omit<LinkedInPost, 'id' | 'createdAt'>): Promise<LinkedInPost> {
        assertTenantId(post.tenantId);
        const inserted = await this.db.insert(engagementPosts).values(post).onConflictDoNothing().returning();
        if (inserted[0]) return inserted[0] as LinkedInPost;
        const existing = await this.db.query.engagementPosts.findFirst({
            where: and(
                eq(engagementPosts.tenantId, post.tenantId),
                eq(engagementPosts.canonicalPostIdentifier, post.canonicalPostIdentifier),
            ),
        });
        if (!existing) throw new Error('POST_INSERT_CONFLICT_UNRESOLVED');
        return existing as LinkedInPost;
    }

    async insertProspectBuyingSignal(signal: Omit<ProspectBuyingSignal, 'id' | 'createdAt'>): Promise<ProspectBuyingSignal> {
        assertTenantId(signal.tenantId);
        const result = await this.db.insert(prospectBuyingSignals).values(signal).returning();
        return result[0] as ProspectBuyingSignal;
    }

    async insertMarketContentInsight(insight: Omit<MarketContentInsight, 'id' | 'createdAt'>): Promise<MarketContentInsight> {
        assertTenantId(insight.tenantId);
        const result = await this.db.insert(marketContentInsights).values(insight).returning();
        return result[0] as MarketContentInsight;
    }

    async upsertDiscoveryQueryStat(stat: { tenantId: string; query: string; postsFound?: number; signalsDetected?: number }): Promise<DiscoveryQueryStat> {
        assertTenantId(stat.tenantId);
        const result = await this.db.insert(discoveryQueryStats).values({
            tenantId: stat.tenantId,
            query: stat.query,
            postsFound: stat.postsFound ?? 0,
            signalsDetected: stat.signalsDetected ?? 0,
            lastSearchedAt: new Date(),
        }).onConflictDoUpdate({
            target: [discoveryQueryStats.tenantId, discoveryQueryStats.query],
            set: {
                postsFound: sql`${discoveryQueryStats.postsFound} + EXCLUDED.posts_found`,
                signalsDetected: sql`${discoveryQueryStats.signalsDetected} + EXCLUDED.signals_detected`,
                lastSearchedAt: new Date(),
            },
        }).returning();
        return result[0] as DiscoveryQueryStat;
    }

    async findBuyingSignalsByTenant(tenantId: string): Promise<ProspectBuyingSignal[]> {
        assertTenantId(tenantId);
        return this.db.select().from(prospectBuyingSignals)
            .where(eq(prospectBuyingSignals.tenantId, tenantId))
            .orderBy(sql`${prospectBuyingSignals.createdAt} desc`) as Promise<ProspectBuyingSignal[]>;
    }

    async findContentInsightsByTenant(tenantId: string): Promise<MarketContentInsight[]> {
        assertTenantId(tenantId);
        return this.db.select().from(marketContentInsights)
            .where(eq(marketContentInsights.tenantId, tenantId))
            .orderBy(sql`${marketContentInsights.createdAt} desc`) as Promise<MarketContentInsight[]>;
    }

    async findQueryStatsByTenant(tenantId: string): Promise<DiscoveryQueryStat[]> {
        assertTenantId(tenantId);
        return this.db.select().from(discoveryQueryStats)
            .where(eq(discoveryQueryStats.tenantId, tenantId))
            .orderBy(sql`${discoveryQueryStats.lastSearchedAt} desc`) as Promise<DiscoveryQueryStat[]>;
    }

    async incrementQueryStatPromoted(tenantId: string, query: string): Promise<void> {
        assertTenantId(tenantId);
        await this.db.update(discoveryQueryStats)
            .set({ prospectsPromoted: sql`${discoveryQueryStats.prospectsPromoted} + 1` })
            .where(and(eq(discoveryQueryStats.tenantId, tenantId), eq(discoveryQueryStats.query, query)));
    }

    // --- Channel 5: Target registry methods ---

    async listEngagerTargets(tenantId: string, opts?: { activeOnly?: boolean }): Promise<EngagerTarget[]> {
        assertTenantId(tenantId);
        const conditions = [eq(engagementTargetSources.tenantId, tenantId)];
        if (opts?.activeOnly) conditions.push(eq(engagementTargetSources.isActive, true));
        return this.db.select().from(engagementTargetSources)
            .where(and(...conditions))
            .orderBy(sql`${engagementTargetSources.createdAt} asc`) as Promise<EngagerTarget[]>;
    }

    async upsertEngagerTarget(target: Omit<EngagerTarget, 'id' | 'createdAt' | 'updatedAt' | 'isActive'> & { isActive?: boolean }): Promise<EngagerTarget> {
        assertTenantId(target.tenantId);
        const existing = await this.db.query.engagementTargetSources.findFirst({
            where: and(
                eq(engagementTargetSources.tenantId, target.tenantId),
                eq(engagementTargetSources.normalizedUrl, target.normalizedUrl),
            ),
        });
        if (existing) return existing as EngagerTarget;
        const inserted = await this.db.insert(engagementTargetSources).values({
            tenantId: target.tenantId,
            targetType: target.targetType,
            displayName: target.displayName,
            linkedinUrl: target.linkedinUrl,
            normalizedUrl: target.normalizedUrl,
            isActive: target.isActive ?? true,
        }).onConflictDoNothing().returning();
        if (inserted[0]) return inserted[0] as EngagerTarget;
        const reRead = await this.db.query.engagementTargetSources.findFirst({
            where: and(
                eq(engagementTargetSources.tenantId, target.tenantId),
                eq(engagementTargetSources.normalizedUrl, target.normalizedUrl),
            ),
        });
        if (!reRead) throw new Error('TARGET_INSERT_CONFLICT_UNRESOLVED');
        return reRead as EngagerTarget;
    }

    async updateEngagerTargetActive(tenantId: string, targetId: string, isActive: boolean): Promise<EngagerTarget | undefined> {
        assertTenantId(tenantId);
        const rows = await this.db.update(engagementTargetSources)
            .set({ isActive, updatedAt: new Date() })
            .where(and(eq(engagementTargetSources.tenantId, tenantId), eq(engagementTargetSources.id, targetId)))
            .returning();
        return rows[0] as EngagerTarget | undefined;
    }

    async findEngagerTargetById(tenantId: string, targetId: string): Promise<EngagerTarget | undefined> {
        assertTenantId(tenantId);
        return this.db.query.engagementTargetSources.findFirst({
            where: and(eq(engagementTargetSources.tenantId, tenantId), eq(engagementTargetSources.id, targetId)),
        }) as Promise<EngagerTarget | undefined>;
    }
}
