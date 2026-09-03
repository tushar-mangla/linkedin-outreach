
import { and, eq, gte, lt, sql, lte } from 'drizzle-orm';
import { PgliteDatabase } from 'drizzle-orm/pglite';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Prospect, IcpEvaluation, ImportBatch, IcpDefinition, ProspectStage, ReviewDecision, AuditEvent } from '../types.js';
import { DBAdapter } from './db-adapter.js';
import { BudgetStorageAdapter } from '../services/budget-storage-adapter.js';
import { LeaseStorageAdapter } from '../services/lease-storage-adapter.js';
import * as schema from './schema.js';
import { assertTenantId, requireTenantId } from './tenant-context.js';
import { dailyActionBudgets, budgetReservations, prospects, icpEvaluations, importBatches, icpDefinitions, accountLeases, reviewDecisions, auditEvents } from './schema.js';

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
    async acquireLease(tenantId: string, accountId: string, workerId: string, ttlSeconds: number): Promise<boolean> {
        assertTenantId(tenantId);
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
        await this.recoverExpiredLeases(tenantId);
        try {
            await this.db.insert(accountLeases).values({
                tenantId,
                accountId,
                workerId,
                expiresAt,
            });
            return true;
        } catch (error) {
            return false;
        }
    }

    async releaseLease(tenantId: string, accountId: string, workerId: string): Promise<void> {
        assertTenantId(tenantId);
        await this.db.delete(accountLeases).where(and(
            eq(accountLeases.tenantId, tenantId),
            eq(accountLeases.accountId, accountId),
            eq(accountLeases.workerId, workerId)
        ));
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
}
