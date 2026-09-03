import { DBAdapter } from '../db/db-adapter.js';
import { LeaseService } from './lease-service.js';
import { BudgetService } from './budget-service.js';
import { LinkedInExecutor, ActionResult } from '../executors/types.js';
import { ScheduledAction } from '../types.js';
import { AuditLogger, auditLogger } from '../lib/audit.js';

export interface ActionQueueServiceOptions {
  db: DBAdapter;
  leaseService: LeaseService;
  budgetService: BudgetService;
  executor: LinkedInExecutor;
  logger?: AuditLogger;
}

export class ActionQueueService {
  private db: DBAdapter;
  private leaseService: LeaseService;
  private budgetService: BudgetService;
  private executor: LinkedInExecutor;
  private logger: AuditLogger;

  constructor(options: ActionQueueServiceOptions) {
    this.db = options.db;
    this.leaseService = options.leaseService;
    this.budgetService = options.budgetService;
    this.executor = options.executor;
    this.logger = options.logger || auditLogger;
  }

  public async scheduleAction(
    actionData: Omit<ScheduledAction, 'id' | 'createdAt' | 'updatedAt' | 'status'>
  ): Promise<ScheduledAction> {
    if (this.db.insertScheduledAction) {
      return this.db.insertScheduledAction(actionData);
    }
    throw new Error('Database adapter does not support scheduling actions');
  }

  public async processNextAction(
    tenantId: string,
    accountId: string,
    workerId: string,
    leaseToken?: string
  ): Promise<{ processed: boolean; action?: ScheduledAction; result?: ActionResult; reason?: string }> {
    // 1. Check Lease Guard
    if (leaseToken) {
      const activeLease = await this.leaseService.getActiveLease(tenantId, accountId);
      if (!activeLease || activeLease.workerId !== workerId || activeLease.leaseToken !== leaseToken) {
        return { processed: false, reason: 'INVALID_OR_EXPIRED_LEASE' };
      }
    }

    // 2. Claim Next Scheduled Action
    if (!this.db.claimNextScheduledAction) {
      throw new Error('Database adapter does not support claiming scheduled actions');
    }
    const action = await this.db.claimNextScheduledAction(tenantId, accountId, workerId);
    if (!action) {
      return { processed: false, reason: 'NO_PENDING_ACTIONS' };
    }

    // 3. Check Daily Budget Reservation
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const reservationId = await this.budgetService.reserveBudget(
      tenantId,
      accountId,
      action.actionType,
      today
    );

    if (!reservationId) {
      // Out of daily quota: revert status back to PENDING for subsequent window
      if (this.db.updateScheduledActionStatus) {
        await this.db.updateScheduledActionStatus(action.id, 'PENDING');
      }
      await this.logger.record({
        action: 'action.budget_exceeded',
        actor: workerId,
        tenantId,
        entityType: 'scheduled_action',
        entityId: action.id,
        details: { actionType: action.actionType, date: today.toISOString() },
      });
      return { processed: false, action, reason: 'BUDGET_EXCEEDED' };
    }

    // 4. Dispatch to Executor
    try {
      let result: ActionResult;
      const payload = action.payload || {};

      switch (action.actionType) {
        case 'visit':
          result = await this.executor.visitProfile({
            scheduledActionId: action.id,
            profileUrl: String(payload.profileUrl || ''),
          });
          break;
        case 'connection':
          result = await this.executor.sendConnection({
            scheduledActionId: action.id,
            profileUrl: String(payload.profileUrl || ''),
            note: payload.note ? String(payload.note) : undefined,
          });
          break;
        case 'message':
          result = await this.executor.sendMessage({
            scheduledActionId: action.id,
            profileUrl: String(payload.profileUrl || ''),
            message: String(payload.message || ''),
          });
          break;
        default:
          throw new Error(`Unsupported action type: ${action.actionType}`);
      }

      if (result.success) {
        await this.budgetService.commitAction(reservationId);
        if (this.db.updateScheduledActionStatus) {
          await this.db.updateScheduledActionStatus(action.id, 'COMPLETED');
        }
        await this.logger.record({
          action: `action.${action.actionType}.completed`,
          actor: workerId,
          tenantId,
          entityType: 'scheduled_action',
          entityId: action.id,
          details: { ...payload, result },
        });
        return { processed: true, action, result };
      } else {
        await this.budgetService.releaseBudget(reservationId);
        if (this.db.updateScheduledActionStatus) {
          await this.db.updateScheduledActionStatus(action.id, 'FAILED');
        }
        await this.logger.record({
          action: `action.${action.actionType}.failed`,
          actor: workerId,
          tenantId,
          entityType: 'scheduled_action',
          entityId: action.id,
          details: { ...payload, result },
        });
        return { processed: true, action, result, reason: 'EXECUTION_FAILED' };
      }
    } catch (error: any) {
      await this.budgetService.releaseBudget(reservationId);
      if (this.db.updateScheduledActionStatus) {
        await this.db.updateScheduledActionStatus(action.id, 'UNCERTAIN');
      }
      await this.logger.record({
        action: `action.${action.actionType}.uncertain`,
        actor: workerId,
        tenantId,
        entityType: 'scheduled_action',
        entityId: action.id,
        details: { error: error.message },
      });
      return { processed: false, action, reason: error.message };
    }
  }
}
