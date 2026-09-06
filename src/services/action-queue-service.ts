import { DBAdapter } from '../db/db-adapter.js';
import { LeaseService } from './lease-service.js';
import { BudgetService } from './budget-service.js';
import { LinkedInExecutor, ActionResult } from '../executors/types.js';
import { ScheduledAction } from '../types.js';
import { AuditLogger, auditLogger } from '../lib/audit.js';
import { SafetyGate } from './safety-gate.js';
import type { SafetyActionInput } from './engagement/execution-contracts.js';
import { randomUUID } from 'node:crypto';
import { redactForAudit } from './safety-resolver.js';

export interface ActionQueueServiceOptions {
  db: DBAdapter;
  leaseService: LeaseService;
  budgetService: BudgetService;
  executor: LinkedInExecutor;
  logger?: AuditLogger;
  safetyGate?: SafetyGate;
  resolveSafety: (action: ScheduledAction, tenantId: string) => Promise<SafetyActionInput | undefined>;
}

export class ActionQueueService {
  private db: DBAdapter;
  private leaseService: LeaseService;
  private budgetService: BudgetService;
  private executor: LinkedInExecutor;
  private logger: AuditLogger;
  private safetyGate: SafetyGate;
  private resolveSafety: ActionQueueServiceOptions['resolveSafety'];

  constructor(options: ActionQueueServiceOptions) {
    this.db = options.db;
    this.leaseService = options.leaseService;
    this.budgetService = options.budgetService;
    this.executor = options.executor;
    this.logger = options.logger || auditLogger;
    this.safetyGate = options.safetyGate || new SafetyGate();
    this.resolveSafety = options.resolveSafety;
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

    // 2. Claim Next Scheduled Action (atomic, token-bound lease on the row)
    const claimToken = randomUUID();
    const action = await this.db.claimNextScheduledAction(tenantId, accountId, workerId, claimToken);
    if (!action) {
      return { processed: false, reason: 'NO_PENDING_ACTIONS' };
    }

    if (action.actionType === 'like' || action.actionType === 'comment') {
      const safety = await this.resolveSafety(action, tenantId);
      if (!safety || safety.tenantId !== tenantId || safety.actionType !== action.actionType.toUpperCase() || safety.postHash !== action.postHash || safety.revisionId !== action.revisionId) {
        await this.db.updateScheduledActionResult(tenantId, action.id, { status: 'FAILED', outcomeLabel: 'failed', errorCode: 'SAFETY_CONTEXT_REQUIRED' });
        return { processed: true, action, reason: 'SAFETY_CONTEXT_REQUIRED' };
      }
      try {
        this.safetyGate.assertActionSafe(safety);
      } catch (error) {
        await this.db.updateScheduledActionResult(tenantId, action.id, { status: 'FAILED', outcomeLabel: 'failed', errorCode: (error as Error).message });
        await this.logger.record({ action: 'action.refused', actor: workerId, tenantId, entityType: 'scheduled_action', entityId: action.id, details: redactForAudit({ code: (error as Error).message, claimToken }) });
        return { processed: true, action, reason: (error as Error).message };
      }
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
      // Out of daily quota: revert claim back to PENDING for subsequent window
      await this.db.updateScheduledActionResult(tenantId, action.id, { status: 'PENDING', errorCode: 'BUDGET_EXCEEDED' });
      await this.logger.record({
        action: 'action.budget_exceeded',
        actor: workerId,
        tenantId,
        entityType: 'scheduled_action',
        entityId: action.id,
        details: redactForAudit({ actionType: action.actionType, date: today.toISOString(), claimToken }),
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
        case 'like':
          result = await this.executor.likePost({
            scheduledActionId: action.id,
            postUrl: String(payload.postUrl || ''),
          });
          break;
        case 'comment':
          result = await this.executor.publishComment({
            scheduledActionId: action.id,
            postUrl: String(payload.postUrl || ''),
            comment: String(payload.comment || ''),
          });
          break;
        default:
          throw new Error(`Unsupported action type: ${action.actionType}`);
      }

      if (result.success) {
        await this.budgetService.commitAction(reservationId);
        await this.db.updateScheduledActionResult(tenantId, action.id, { status: 'COMPLETED', outcomeLabel: result.outcomeLabel });
        await this.logger.record({
          action: `action.${action.actionType}.completed`,
          actor: workerId,
          tenantId,
          entityType: 'scheduled_action',
          entityId: action.id,
          details: redactForAudit({ result, claimToken }),
        });
        return { processed: true, action, result };
      } else {
        await this.budgetService.releaseBudget(reservationId);
         if (result.errorCode === 'MANUAL_CONFIRMATION_PENDING') {
           await this.db.createManualTask({ tenantId, scheduledActionId: action.id, actionType: action.actionType.toUpperCase() as 'LIKE' | 'COMMENT' });
           // Keep the action CLAIMED (non-claimable) until the manual task resolves it.
           // Resetting to PENDING here would allow a second worker to re-claim it.
           await this.db.updateScheduledActionResult(tenantId, action.id, { status: 'CLAIMED', outcomeLabel: result.outcomeLabel, errorCode: result.errorCode });
         } else {
           await this.db.updateScheduledActionResult(tenantId, action.id, { status: 'FAILED', outcomeLabel: result.outcomeLabel, errorCode: result.errorCode });
         }
        await this.logger.record({
          action: `action.${action.actionType}.failed`,
          actor: workerId,
          tenantId,
          entityType: 'scheduled_action',
          entityId: action.id,
          details: redactForAudit({ result, claimToken }),
        });
        return { processed: true, action, result, reason: 'EXECUTION_FAILED' };
      }
    } catch (error: any) {
      await this.budgetService.releaseBudget(reservationId);
       await this.db.updateScheduledActionResult(tenantId, action.id, { status: 'UNCERTAIN', outcomeLabel: 'uncertain', errorCode: 'EXECUTION_UNCERTAIN' });
      await this.logger.record({
        action: `action.${action.actionType}.uncertain`,
        actor: workerId,
        tenantId,
        entityType: 'scheduled_action',
        entityId: action.id,
        details: redactForAudit({ error: error.message, claimToken }),
      });
      return { processed: false, action, reason: error.message };
    }
  }
}
