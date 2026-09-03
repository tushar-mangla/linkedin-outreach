
import { v4 as uuidv4 } from 'uuid';
import {
  Prospect,
  DailyActionBudget,
  BudgetReservation,
  AccountLease,
  IcpDefinition,
  ImportBatch,
  IcpEvaluation,
  ProspectStage,
  ReviewDecision,
  AuditEvent,
  Campaign,
  SequenceDefinition,
  CampaignEnrollment,
  ScheduledAction,
} from '../types.js';

import { DBAdapter } from './db-adapter.js';
import { BudgetStorageAdapter } from '../services/budget-storage-adapter.js';
import { LeaseStorageAdapter } from '../services/lease-storage-adapter.js';

type MemoryStorageTables = {
  prospects: Prospect[];
  dailyActionBudgets: DailyActionBudget[];
  accountLeases: AccountLease[];
  icpDefinitions: IcpDefinition[];
  importBatches: ImportBatch[];
  icpEvaluations: IcpEvaluation[];
  tenants: { id: string; name: string }[];
  users: { id: string; tenantId: string; name: string }[];
  auditEvents: AuditEvent[];
  budgetReservations: BudgetReservation[];
  reviewDecisions: ReviewDecision[];
  campaigns: Campaign[];
  sequenceDefinitions: SequenceDefinition[];
  campaignEnrollments: CampaignEnrollment[];
  scheduledActions: ScheduledAction[];
};

export class MemoryStorage implements DBAdapter, BudgetStorageAdapter, LeaseStorageAdapter {
  private tables: MemoryStorageTables = {
    prospects: [],
    dailyActionBudgets: [],
    accountLeases: [],
    icpDefinitions: [],
    importBatches: [],
    icpEvaluations: [],
    tenants: [],
    users: [],
    auditEvents: [],
    budgetReservations: [],
    reviewDecisions: [],
    campaigns: [],
    sequenceDefinitions: [],
    campaignEnrollments: [],
    scheduledActions: [],
  };

  // --- Prospect Methods ---
  async insertProspect(prospectData: Omit<Prospect, 'id' | 'createdAt' | 'updatedAt' | 'currentStage'>): Promise<Prospect> {
    const newProspect: Prospect = {
      id: uuidv4(),
      ...prospectData,
      currentStage: 'INGESTED',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.tables.prospects.push(newProspect);
    return newProspect;
  }

  async updateProspectStage(prospectId: string, stage: ProspectStage): Promise<Prospect | undefined> {
    const prospect = this.tables.prospects.find(p => p.id === prospectId);
    if (prospect) {
      prospect.currentStage = stage;
      prospect.updatedAt = new Date();
    }
    return prospect;
  }

  async findProspectByTenantAndUrl(tenantId: string, normalizedLinkedinUrl: string): Promise<Prospect | undefined> {
      return this.tables.prospects.find(p => p.tenantId === tenantId && p.normalizedLinkedinUrl === normalizedLinkedinUrl);
  }

  async updateProspect(prospectId: string, prospectData: Partial<Omit<Prospect, 'id' | 'tenantId' | 'normalizedLinkedinUrl'>>): Promise<Prospect | undefined> {
    const prospect = this.tables.prospects.find(p => p.id === prospectId);
    if (prospect) {
        Object.assign(prospect, { ...prospectData, updatedAt: new Date() });
    }
    return prospect;
  }

  // --- ICP Evaluation Methods ---
  async insertIcpEvaluation(evaluation: Omit<IcpEvaluation, 'id' | 'createdAt'>): Promise<IcpEvaluation> {
    const newEvaluation: IcpEvaluation = {
      id: uuidv4(),
      ...evaluation,
      createdAt: new Date(),
    };
    this.tables.icpEvaluations.push(newEvaluation);
    return newEvaluation;
  }

  // --- Import Batch Methods ---
    async insertImportBatch(batchData: Omit<ImportBatch, 'id' | 'createdAt' | 'updatedAt' | 'processedRows' | 'qualifiedCount' | 'rejectedCount' | 'reviewCount' | 'status'>): Promise<ImportBatch> {
        const newBatch: ImportBatch = {
            id: uuidv4(),
            ...batchData,
            processedRows: 0,
            qualifiedCount: 0,
            rejectedCount: 0,
            reviewCount: 0,
            status: 'PROCESSING',
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        this.tables.importBatches.push(newBatch);
        return newBatch;
    }

    async updateImportBatch(batchId: string, updates: Partial<ImportBatch>): Promise<ImportBatch | undefined> {
        const batch = this.tables.importBatches.find(b => b.id === batchId);
        if (batch) {
            Object.assign(batch, { ...updates, updatedAt: new Date() });
        }
        return batch;
    }

  // --- ICP Definition Methods ---
  async findIcpDefinitionById(icpDefinitionId: string): Promise<IcpDefinition | undefined> {
      return this.tables.icpDefinitions.find(def => def.id === icpDefinitionId);
  }

  // --- Budget Service Methods ---
  async reserveBudget(tenantId: string, accountId: string, actionType: string, budgetDate: Date): Promise<string | undefined> {
    const budget = this.tables.dailyActionBudgets.find(
      b =>
        b.tenantId === tenantId &&
        b.accountId === accountId &&
        b.actionType === actionType &&
        b.budgetDate.getTime() === budgetDate.getTime()
    );

    if (!budget) {
        return undefined;
    }

    if (budget.reservedCount + budget.completedCount + 1 <= budget.limit) {
      budget.reservedCount += 1;
      const reservation: BudgetReservation = {
        id: uuidv4(),
        tenantId,
        accountId,
        actionType,
        budgetDate,
        status: 'RESERVED',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.tables.budgetReservations.push(reservation);
      return reservation.id;
    }

    return undefined;
  }

    async commitAction(reservationId: string): Promise<void> {
      const reservation = this.tables.budgetReservations.find(r => r.id === reservationId && r.status === 'RESERVED');
        const budget = this.tables.dailyActionBudgets.find(
            b =>
          reservation && b.tenantId === reservation.tenantId &&
          b.accountId === reservation.accountId &&
          b.actionType === reservation.actionType &&
          b.budgetDate.getTime() === reservation.budgetDate.getTime()
        );

      if (reservation && budget && budget.reservedCount > 0) {
            budget.reservedCount -= 1;
            budget.completedCount += 1;
        reservation.status = 'COMMITTED';
        reservation.updatedAt = new Date();
        }
    }

    async releaseBudget(reservationId: string): Promise<void> {
      const reservation = this.tables.budgetReservations.find(r => r.id === reservationId && r.status === 'RESERVED');
        const budget = this.tables.dailyActionBudgets.find(
            b =>
          reservation && b.tenantId === reservation.tenantId &&
          b.accountId === reservation.accountId &&
          b.actionType === reservation.actionType &&
          b.budgetDate.getTime() === reservation.budgetDate.getTime()
        );

      if (reservation && budget && budget.reservedCount > 0) {
            budget.reservedCount -= 1;
        reservation.status = 'RELEASED';
        reservation.updatedAt = new Date();
        }
    }

  // --- Lease Service Methods ---
  async acquireLease(tenantId: string, accountId: string, workerId: string, ttlSeconds: number, leaseToken?: string): Promise<boolean> {
    const now = new Date();
    await this.recoverExpiredLeases(tenantId);
    const existingLease = this.tables.accountLeases.find(
      l => l.tenantId === tenantId && l.accountId === accountId && l.expiresAt > now
    );

    if (existingLease) {
      return false;
    }

    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const newLease: AccountLease = {
      id: uuidv4(),
      tenantId,
      accountId,
      workerId,
      leaseToken: leaseToken || uuidv4(),
      expiresAt,
      heartbeatAt: now,
      createdAt: now,
    };
    this.tables.accountLeases.push(newLease);
    return true;
  }

  async acquireLeaseToken(tenantId: string, accountId: string, workerId: string, ttlSeconds: number): Promise<string | null> {
    const token = uuidv4();
    const ok = await this.acquireLease(tenantId, accountId, workerId, ttlSeconds, token);
    return ok ? token : null;
  }

  async releaseLease(tenantId: string, accountId: string, workerId: string, leaseToken?: string): Promise<void> {
    this.tables.accountLeases = this.tables.accountLeases.filter(l => {
      const isTarget = l.tenantId === tenantId && l.accountId === accountId && l.workerId === workerId;
      if (!isTarget) return true;
      if (leaseToken && l.leaseToken !== leaseToken) {
        return true; // Stale token protection: do not release other worker's lease
      }
      return false;
    });
  }

  async heartbeatLease(
    tenantId: string,
    accountId: string,
    workerId: string,
    leaseToken: string,
    ttlSeconds: number
  ): Promise<boolean> {
    const now = new Date();
    const lease = this.tables.accountLeases.find(
      l =>
        l.tenantId === tenantId &&
        l.accountId === accountId &&
        l.workerId === workerId &&
        l.leaseToken === leaseToken &&
        l.expiresAt > now
    );
    if (!lease) {
      return false;
    }
    lease.expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    lease.heartbeatAt = now;
    return true;
  }

  async getActiveLease(tenantId: string, accountId: string): Promise<AccountLease | undefined> {
    const now = new Date();
    return this.tables.accountLeases.find(
      l => l.tenantId === tenantId && l.accountId === accountId && l.expiresAt > now
    );
  }

  async recoverExpiredLeases(tenantId: string): Promise<void> {
    const now = new Date();
    this.tables.accountLeases = this.tables.accountLeases.filter(
      l => !(l.tenantId === tenantId && l.expiresAt <= now)
    );
  }

  async applyOverride(tenantId: string, prospectId: string, newStage: ProspectStage): Promise<void> {
      const prospect = this.tables.prospects.find(p => p.tenantId === tenantId && p.id === prospectId);
      if (prospect) {
          prospect.currentStage = newStage;
          prospect.updatedAt = new Date();
      }
  }

  async exportReadyProspects(tenantId: string): Promise<any[]> {
      return this.tables.prospects.filter(
        p => p.tenantId === tenantId && (p.currentStage === 'READY_FOR_CAMPAIGN' || p.currentStage === 'APPROVED_FOR_OUTREACH')
      );
  }

  async insertReviewDecision(decision: Omit<ReviewDecision, 'id' | 'createdAt'>): Promise<ReviewDecision> {
    const record: ReviewDecision = { id: uuidv4(), ...decision, createdAt: new Date() };
    this.tables.reviewDecisions.push(record);
    return record;
  }

  async insertAuditEvent(event: Omit<AuditEvent, 'id' | 'createdAt'>): Promise<AuditEvent> {
    const record: AuditEvent = { id: uuidv4(), ...event, createdAt: new Date() };
    this.tables.auditEvents.push(record);
    return record;
  }

  async getAuditEvents(tenantId: string): Promise<AuditEvent[]> {
    return this.tables.auditEvents.filter(e => e.tenantId === tenantId);
  }

  // --- Campaign & Scheduled Action Methods ---
  async insertCampaign(campaign: Omit<Campaign, 'id' | 'createdAt' | 'updatedAt'>): Promise<Campaign> {
    const record: Campaign = {
      id: uuidv4(),
      ...campaign,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.tables.campaigns.push(record);
    return record;
  }

  async insertScheduledAction(action: Omit<ScheduledAction, 'id' | 'createdAt' | 'updatedAt' | 'status'>): Promise<ScheduledAction> {
    const record: ScheduledAction = {
      id: uuidv4(),
      ...action,
      status: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.tables.scheduledActions.push(record);
    return record;
  }

  async claimNextScheduledAction(tenantId: string, accountId: string, workerId: string): Promise<ScheduledAction | undefined> {
    const now = new Date();
    const action = this.tables.scheduledActions.find(
      a =>
        a.tenantId === tenantId &&
        a.accountId === accountId &&
        a.status === 'PENDING' &&
        a.scheduledFor <= now
    );
    if (action) {
      action.status = 'CLAIMED';
      action.claimedBy = workerId;
      action.claimedAt = now;
      action.updatedAt = now;
    }
    return action;
  }

  async updateScheduledActionStatus(actionId: string, status: ScheduledAction['status']): Promise<ScheduledAction | undefined> {
    const action = this.tables.scheduledActions.find(a => a.id === actionId);
    if (action) {
      action.status = status;
      action.updatedAt = new Date();
      if (status === 'COMPLETED' || status === 'FAILED' || status === 'UNCERTAIN') {
        action.completedAt = new Date();
      }
    }
    return action;
  }

  // --- Test utility methods ---
  public getTable<T extends keyof MemoryStorageTables>(tableName: T): MemoryStorageTables[T] {
    return this.tables[tableName];
  }

  public clear() {
    this.tables = {
      prospects: [],
      dailyActionBudgets: [],
      accountLeases: [],
      icpDefinitions: [],
      importBatches: [],
      icpEvaluations: [],
      tenants: [],
      users: [],
      auditEvents: [],
      budgetReservations: [],
      reviewDecisions: [],
      campaigns: [],
      sequenceDefinitions: [],
      campaignEnrollments: [],
      scheduledActions: [],
    };
  }
}

export const memoryStorage = new MemoryStorage();

