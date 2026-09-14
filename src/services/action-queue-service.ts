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
import { isTransientDbError } from '../db/retry.js';


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
    // 0. Recover stale claims older than lease TTL
    if (this.db.recoverStaleClaims) {
      try {
        await this.db.recoverStaleClaims(15 * 60 * 1000, tenantId, accountId);
      } catch (err) {
        if (!isTransientDbError(err)) {
          console.warn('[ActionQueueService] Stale claim recovery warning:', (err as Error).message);
        }
      }
    }

    // Resume any PAUSED_BUDGET actions whose scheduled_for has passed (next budget window)
    if (this.db.resumePausedActions) {
      try {
        await this.db.resumePausedActions(tenantId);
      } catch (err) {
        if (!isTransientDbError(err)) {
          console.warn('[ActionQueueService] resumePausedActions warning:', (err as Error).message);
        }
      }
    }

    // 1. Check Lease Guard
    if (leaseToken) {
      const activeLease = await this.leaseService.getActiveLease(tenantId, accountId);
      if (!activeLease || activeLease.workerId !== workerId || activeLease.leaseToken !== leaseToken) {
        return { processed: false, reason: 'INVALID_OR_EXPIRED_LEASE' };
      }
    }

    // 2. Claim Next Scheduled Action (atomic, token-bound lease on the row)
    const claimToken = randomUUID();
    let action: ScheduledAction | undefined;
    try {
      action = await this.db.claimNextScheduledAction(tenantId, accountId, workerId, claimToken);
    } catch (claimErr) {
      if (isTransientDbError(claimErr)) {
        return { processed: false, reason: 'DB_RETRYABLE' };
      }
      throw claimErr;
    }
    if (!action) {
      return { processed: false, reason: 'NO_PENDING_ACTIONS' };
    }

    let reservationId: string | undefined = undefined;
    try {
      if (action.actionType === 'comment' && !await this.db.isCommentSlotOwner(tenantId, accountId, action.id)) {
        await this.db.updateScheduledActionResult(tenantId, action.id, { status: 'FAILED', outcomeLabel: 'refused', errorCode: 'COMMENT_SLOT_OWNER_REQUIRED' });
        return { processed: true, action, reason: 'COMMENT_SLOT_OWNER_REQUIRED' };
      }

      if (action.actionType === 'like' || action.actionType === 'comment') {
        const safety = await this.resolveSafety(action, tenantId);
        if (!safety || safety.tenantId !== tenantId || safety.actionType !== action.actionType.toUpperCase() || safety.postHash !== action.postHash || safety.revisionId !== action.revisionId) {
          await this.db.finalizeCommentAction(tenantId, action.id, { status: 'FAILED', outcomeLabel: 'failed', errorCode: 'SAFETY_CONTEXT_REQUIRED' });
          return { processed: true, action, reason: 'SAFETY_CONTEXT_REQUIRED' };
        }
        try {
          this.safetyGate.assertActionSafe(safety);
        } catch (error) {
          await this.db.finalizeCommentAction(tenantId, action.id, { status: 'FAILED', outcomeLabel: 'failed', errorCode: (error as Error).message });
          await this.logger.record({ action: 'action.refused', actor: workerId, tenantId, entityType: 'scheduled_action', entityId: action.id, details: redactForAudit({ code: (error as Error).message, claimToken }) });
          return { processed: true, action, reason: (error as Error).message };
        }

        if (this.db.checkEngagementCooldown) {
          const cooldownCheck = await this.db.checkEngagementCooldown(tenantId, action.prospectId, action.actionType);
          if (!cooldownCheck.allowed) {
            await this.db.finalizeCommentAction(tenantId, action.id, { status: 'FAILED', outcomeLabel: 'refused', errorCode: 'COOLDOWN_ACTIVE' });
            await this.logger.record({ action: 'action.refused', actor: workerId, tenantId, entityType: 'scheduled_action', entityId: action.id, details: redactForAudit({ code: 'COOLDOWN_ACTIVE', reason: cooldownCheck.reason, claimToken }) });
            return { processed: true, action, reason: 'COOLDOWN_ACTIVE' };
          }
        }
      }

      // 3. Check Daily Budget Reservation
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      reservationId = await this.budgetService.reserveBudget(
        tenantId,
        accountId,
        action.actionType,
        today
      );

      if (!reservationId) {
        // Out of daily quota: pause until next budget window (local midnight); do not re-claim in this cycle
        const nextWindow = new Date();
        nextWindow.setHours(24, 0, 0, 0);
        await this.db.updateScheduledActionResult(tenantId, action.id, {
          status: 'PAUSED_BUDGET',
          errorCode: 'BUDGET_EXCEEDED',
          scheduledFor: nextWindow,
        });
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
    } catch (preDispatchError: unknown) {
      if (reservationId) {
        try {
          await this.budgetService.releaseBudget(reservationId);
        } catch {
          // Ignore budget release failure on transient error
        }
      }

      if (isTransientDbError(preDispatchError)) {
        // Pre-dispatch transient error: revert to PENDING with failureReason DB_RETRYABLE
        try {
          await this.db.updateScheduledActionResult(tenantId, action.id, {
            status: 'PENDING',
            errorCode: 'DB_TRANSIENT',
          });
        } catch (revertErr) {
          console.warn('[ActionQueueService] Failed to revert transiently failed action to PENDING:', (revertErr as Error).message);
        }
        return { processed: false, action, reason: 'DB_RETRYABLE' };
      }

      throw preDispatchError;
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
        await this.db.finalizeCommentAction(tenantId, action.id, { status: 'COMPLETED', outcomeLabel: result.outcomeLabel }, workerId);
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
          const execErrorCode = result.errorCode || 'EXECUTION_FAILED';
          const RETRYABLE_EXECUTION_ERROR_CODES = ['SELECTOR_MISMATCH', 'RATE_LIMITED', 'EXECUTION_TIMEOUT'];
          const isRetryable = RETRYABLE_EXECUTION_ERROR_CODES.includes(execErrorCode);
          const currentAttempt = action.attemptCount ?? 0;
          const nextAttempt = currentAttempt + 1;
          if (isRetryable && nextAttempt < 3) {
            const backoffMs = 5 * 60 * 1000;
            const nextScheduledFor = new Date(Date.now() + backoffMs);
            await this.db.updateScheduledActionResult(tenantId, action.id, {
              status: 'PENDING',
              errorCode: execErrorCode,
              attemptCount: nextAttempt,
              scheduledFor: nextScheduledFor,
            });
            await this.logger.record({
              action: `action.${action.actionType}.retry`,
              actor: workerId,
              tenantId,
              entityType: 'scheduled_action',
              entityId: action.id,
              details: redactForAudit({ attempt: nextAttempt, errorCode: execErrorCode, claimToken }),
            });
            return { processed: true, action, result, reason: 'RETRY_SCHEDULED' };
          } else {
            // Non-retryable (incl. safety refusals like COOLDOWN_ACTIVE that reach here) or ceiling reached → dead-letter
            await this.db.finalizeCommentAction(tenantId, action.id, { status: 'FAILED', outcomeLabel: result.outcomeLabel, errorCode: execErrorCode });
          }
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
      if (reservationId) {
        await this.budgetService.releaseBudget(reservationId);
      }
      await this.db.finalizeCommentAction(tenantId, action.id, { status: 'UNCERTAIN', outcomeLabel: 'uncertain', errorCode: 'EXECUTION_UNCERTAIN' });
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
