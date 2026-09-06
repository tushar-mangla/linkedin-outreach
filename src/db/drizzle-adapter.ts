
import { and, eq, gte, lt, sql, lte } from 'drizzle-orm';
import { PgliteDatabase } from 'drizzle-orm/pglite';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Prospect, IcpEvaluation, ImportBatch, IcpDefinition, ProspectStage, ReviewDecision, AuditEvent } from '../types.js';
import { DBAdapter } from './db-adapter.js';
import { BudgetStorageAdapter } from '../services/budget-storage-adapter.js';
import { LeaseStorageAdapter } from '../services/lease-storage-adapter.js';
import * as schema from './schema.js';
import { assertTenantId, requireTenantId } from './tenant-context.js';
import { dailyActionBudgets, budgetReservations, prospects, icpEvaluations, importBatches, icpDefinitions, accountLeases, reviewDecisions, auditEvents, scheduledActions, manualTasks } from './schema.js';

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

    async claimNextScheduledAction(tenantId: string, accountId: string, workerId: string, claimToken?: string) {
        assertTenantId(tenantId);
        const { randomUUID } = await import('node:crypto');
        const token = claimToken ?? randomUUID();
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
            claimedBy: (row.claimed_by as string) ?? undefined,
            claimedAt: row.claimed_at ? new Date(row.claimed_at as string) : undefined,
            completedAt: row.completed_at ? new Date(row.completed_at as string) : undefined,
            createdAt: new Date(row.created_at as string),
            updatedAt: new Date(row.updated_at as string),
        } as import('../types.js').ScheduledAction;
    }

    async updateScheduledActionStatus(actionId: string, status: import('../types.js').ScheduledAction['status']) {
        const tenantId = requireTenantId();
        const current = await this.db.query.scheduledActions.findFirst({ where: and(eq(scheduledActions.id, actionId), eq(scheduledActions.tenantId, tenantId)) });
        if (!current) return undefined;
        if (TERMINAL_SCHEDULED_ACTION_STATUSES.includes(current.status)) {
            throw new Error('TERMINAL_STATE_IMMUTABLE');
        }
        const rows = await this.db.update(scheduledActions).set({ status, updatedAt: new Date(), completedAt: TERMINAL_SCHEDULED_ACTION_STATUSES.includes(status) ? new Date() : current.completedAt }).where(and(eq(scheduledActions.id, actionId), eq(scheduledActions.tenantId, tenantId))).returning();
        return rows[0] as import('../types.js').ScheduledAction | undefined;
    }

    async updateScheduledActionResult(tenantId: string, actionId: string, result: { status: import('../types.js').ScheduledAction['status']; outcomeLabel?: import('../types.js').ScheduledAction['outcomeLabel']; errorCode?: string }) {
        assertTenantId(tenantId);
        const current = await this.db.query.scheduledActions.findFirst({ where: and(eq(scheduledActions.id, actionId), eq(scheduledActions.tenantId, tenantId)) });
        if (!current) return undefined;
        if (TERMINAL_SCHEDULED_ACTION_STATUSES.includes(current.status)) {
            throw new Error('TERMINAL_STATE_IMMUTABLE');
        }
        const rows = await this.db.update(scheduledActions).set({ status: result.status, outcomeLabel: result.outcomeLabel, errorCode: result.errorCode, completedAt: TERMINAL_SCHEDULED_ACTION_STATUSES.includes(result.status) ? new Date() : undefined, updatedAt: new Date() }).where(and(eq(scheduledActions.id, actionId), eq(scheduledActions.tenantId, tenantId))).returning();
        return rows[0] as import('../types.js').ScheduledAction | undefined;
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
        return rows[0] as { status: string; outcomeLabel?: 'manual-confirmed' | 'uncertain' };
    }
}
