import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../db/memory-storage.js';
import { BudgetService } from './budget-service.js';
import { LeaseService } from './lease-service.js';
import { ActionQueueService } from './action-queue-service.js';
import { FakeExecutor } from '../executors/fake.js';
import { TransientDbError } from '../db/retry.js';

const tenantId = '00000000-0000-0000-0000-000000000001';
const accountId = '00000000-0000-0000-0000-000000000002';
const prospectId = '00000000-0000-0000-0000-000000000003';
const postHash = 'b'.repeat(64);

function makeAction(actionType: 'like' | 'comment', key: string) {
  return {
    tenantId,
    prospectId,
    accountId,
    actionType,
    payload: { postUrl: `https://fixture.test/${actionType}`, comment: 'Grounded comment' },
    scheduledFor: new Date(Date.now() - 1_000),
    idempotencyKey: key,
    revisionId: `revision-${actionType}`,
    postHash,
    mode: 'SIMULATE' as const,
  };
}

function makeSafety(actionType: 'LIKE' | 'COMMENT', revisionId: string) {
  return {
    tenantId,
    prospectReady: true,
    postEligible: true,
    approvalCurrent: true,
    actionType,
    mode: 'SIMULATE' as const,
    revisionId,
    postHash,
    policy: {
      likeEnabled: actionType === 'LIKE',
      commentEnabled: actionType === 'COMMENT',
      feature05BrowserEnabled: false,
      pilotActionsRemaining: 4,
      killSwitchActive: false,
      accountPaused: false,
      sessionHealthy: true,
      cooldownActive: false,
      budgetAvailable: true,
      leaseValid: true,
      workingHours: true,
    },
  };
}

describe('ActionQueueService Resilience', () => {
  it('reverts pre-dispatch transient DB error to PENDING with DB_RETRYABLE and heals on next tick', async () => {
    const storage = new MemoryStorage();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    storage.getTable('dailyActionBudgets').push({
      id: 'budget-like',
      tenantId,
      accountId,
      actionType: 'like',
      budgetDate: today,
      limit: 2,
      reservedCount: 0,
      completedCount: 0,
      createdAt: today,
      updatedAt: today,
    });

    const lease = new LeaseService(storage);
    const token = await lease.acquireLeaseWithToken(tenantId, accountId, 'worker', 60);

    let failWithTransientError = true;

    const queue = new ActionQueueService({
      db: storage,
      leaseService: lease,
      budgetService: new BudgetService(storage),
      executor: new FakeExecutor(),
      resolveSafety: async (scheduled) => {
        if (failWithTransientError) {
          throw new TransientDbError('Connection terminated due to connection timeout');
        }
        return makeSafety('LIKE', scheduled.revisionId!);
      },
    });

    const scheduled = await queue.scheduleAction(makeAction('like', 'like-resilient'));
    expect(scheduled.status).toBe('PENDING');

    // Tick 1: Transient error occurs during pre-dispatch
    const firstResult = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);
    expect(firstResult.processed).toBe(false);
    expect(firstResult.reason).toBe('DB_RETRYABLE');

    // Row must NOT be stuck in CLAIMED status and must NOT be marked FAILED
    const actionInDb = storage.getTable('scheduledActions').find((a) => a.id === scheduled.id);
    expect(actionInDb?.status).toBe('PENDING');
    expect(actionInDb?.errorCode).toBe('DB_TRANSIENT');

    // Budget was not consumed
    const budgetInDb = storage.getTable('dailyActionBudgets').find((b) => b.id === 'budget-like');
    expect(budgetInDb?.reservedCount).toBe(0);
    expect(budgetInDb?.completedCount).toBe(0);

    // Tick 2: DB recovers (failWithTransientError = false)
    failWithTransientError = false;
    const secondResult = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);
    expect(secondResult.processed).toBe(true);
    expect(secondResult.result?.outcomeLabel).toBe('simulated');

    // Now it is COMPLETED exactly once
    const completedAction = storage.getTable('scheduledActions').find((a) => a.id === scheduled.id);
    expect(completedAction?.status).toBe('COMPLETED');
    expect(budgetInDb?.completedCount).toBe(1);
  });

  it('leaves post-dispatch errors UNCERTAIN to prevent duplicate execution', async () => {
    const storage = new MemoryStorage();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    storage.getTable('dailyActionBudgets').push({
      id: 'budget-like-fail',
      tenantId,
      accountId,
      actionType: 'like',
      budgetDate: today,
      limit: 2,
      reservedCount: 0,
      completedCount: 0,
      createdAt: today,
      updatedAt: today,
    });

    const lease = new LeaseService(storage);
    const token = await lease.acquireLeaseWithToken(tenantId, accountId, 'worker', 60);

    // Throwing executor to simulate post-dispatch failure
    const failingExecutor: any = {
      likePost: async () => {
        throw new Error('Network socket disconnected after sending payload');
      },
    };

    const queue = new ActionQueueService({
      db: storage,
      leaseService: lease,
      budgetService: new BudgetService(storage),
      executor: failingExecutor,
      resolveSafety: async (scheduled) => makeSafety('LIKE', scheduled.revisionId!),
    });

    const scheduled = await queue.scheduleAction(makeAction('like', 'like-uncertain'));
    const result = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);

    expect(result.processed).toBe(false);
    expect(result.reason).toContain('Network socket disconnected');

    const actionInDb = storage.getTable('scheduledActions').find((a) => a.id === scheduled.id);
    // MUST remain UNCERTAIN, never reset to PENDING
    expect(actionInDb?.status).toBe('UNCERTAIN');
    expect(actionInDb?.outcomeLabel).toBe('uncertain');
  });

  it('recovers stale CLAIMED actions when lease is expired or absent', async () => {
    const storage = new MemoryStorage();
    const actionId = 'action-stale-1';
    const oldDate = new Date(Date.now() - 20 * 60 * 1000); // 20 minutes ago

    storage.getTable('scheduledActions').push({
      id: actionId,
      tenantId,
      accountId,
      prospectId,
      actionType: 'like',
      status: 'CLAIMED',
      scheduledFor: oldDate,
      idempotencyKey: 'stale-claim-test',
      claimedBy: 'dead-worker',
      claimedAt: oldDate,
      createdAt: oldDate,
      updatedAt: oldDate,
    });

    // Stale claim without active lease should be recovered
    const recovered = await storage.recoverStaleClaims(15 * 60 * 1000, tenantId, accountId);
    expect(recovered).toBe(1);

    const actionInDb = storage.getTable('scheduledActions').find((a) => a.id === actionId);
    expect(actionInDb?.status).toBe('PENDING');
    expect(actionInDb?.errorCode).toBe('DB_TRANSIENT');
  });

  it('recovers stale claim falling back to updatedAt when claimedAt is omitted/null', async () => {
    const storage = new MemoryStorage();
    const actionId = 'action-stale-no-claimed-at';
    const oldDate = new Date(Date.now() - 25 * 60 * 1000); // 25 minutes ago

    storage.getTable('scheduledActions').push({
      id: actionId,
      tenantId,
      accountId,
      prospectId,
      actionType: 'like',
      status: 'CLAIMED',
      scheduledFor: oldDate,
      idempotencyKey: 'stale-claim-no-claimed-at',
      claimedBy: 'dead-worker',
      claimedAt: undefined,
      createdAt: oldDate,
      updatedAt: oldDate,
    });

    const recovered = await storage.recoverStaleClaims(15 * 60 * 1000, tenantId, accountId);
    expect(recovered).toBe(1);

    const actionInDb = storage.getTable('scheduledActions').find((a) => a.id === actionId);
    expect(actionInDb?.status).toBe('PENDING');
    expect(actionInDb?.errorCode).toBe('DB_TRANSIENT');
  });

  it('does NOT recover fresh CLAIMED actions when lease is active', async () => {
    const storage = new MemoryStorage();
    const actionId = 'action-fresh-1';
    const now = new Date();

    storage.getTable('accountLeases').push({
      id: 'lease-active-1',
      tenantId,
      accountId,
      workerId: 'active-worker',
      leaseToken: 'token-active',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000), // active for 5 mins
      createdAt: now,
    });

    storage.getTable('scheduledActions').push({
      id: actionId,
      tenantId,
      accountId,
      prospectId,
      actionType: 'like',
      status: 'CLAIMED',
      scheduledFor: now,
      idempotencyKey: 'fresh-claim-test',
      claimedBy: 'active-worker',
      claimedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const recovered = await storage.recoverStaleClaims(15 * 60 * 1000, tenantId, accountId);
    expect(recovered).toBe(0);

    const actionInDb = storage.getTable('scheduledActions').find((a) => a.id === actionId);
    expect(actionInDb?.status).toBe('CLAIMED');
  });
});
