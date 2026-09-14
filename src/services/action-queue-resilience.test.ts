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

function makeAction(actionType: 'like' | 'comment', key: string, postUrl = `https://fixture.test/${actionType}`) {
  return {
    tenantId,
    prospectId,
    accountId,
    actionType,
    payload: { postUrl, comment: 'Grounded comment' },
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

describe('ActionQueueService budget pause & retry ceiling (post-integrity remediation)', () => {
  it('pauses budget-exceeded actions as PAUSED_BUDGET (not PENDING) and does not re-claim them', async () => {
    const storage = new MemoryStorage();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    storage.getTable('dailyActionBudgets').push({
      id: 'budget-like-zero', tenantId, accountId, actionType: 'like', budgetDate: today,
      limit: 0, reservedCount: 0, completedCount: 0, createdAt: today, updatedAt: today,
    });
    const lease = new LeaseService(storage);
    const token = await lease.acquireLeaseWithToken(tenantId, accountId, 'worker', 60);
    const queue = new ActionQueueService({
      db: storage, leaseService: lease, budgetService: new BudgetService(storage),
      executor: new FakeExecutor(),
      resolveSafety: async (scheduled) => makeSafety('LIKE', scheduled.revisionId!),
    });

    const scheduled = await queue.scheduleAction(makeAction('like', 'budget-paused'));
    const result = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);

    expect(result.reason).toBe('BUDGET_EXCEEDED');
    const stored = storage.getTable('scheduledActions').find((a) => a.id === scheduled.id)!;
    expect(stored.status).toBe('PAUSED_BUDGET'); // NOT PENDING → no hot loop
    expect(stored.errorCode).toBe('BUDGET_EXCEEDED');
    expect(stored.scheduledFor.getTime()).toBeGreaterThan(Date.now()); // pushed to next window
    expect(stored.scheduledFor.getHours()).toBe(0); // aligned with local midnight
    expect(stored.scheduledFor.getMinutes()).toBe(0);

    // Next tick: PAUSED_BUDGET is not claimable
    const next = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);
    expect(next.reason).toBe('NO_PENDING_ACTIONS');
    expect(storage.getTable('scheduledActions').find((a) => a.id === scheduled.id)!.status).toBe('PAUSED_BUDGET');
  });

  it('resumes a PAUSED_BUDGET action to PENDING once its scheduled_for window passes and completes it', async () => {
    const storage = new MemoryStorage();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    storage.getTable('dailyActionBudgets').push({
      id: 'budget-like-resume', tenantId, accountId, actionType: 'like', budgetDate: today,
      limit: 0, reservedCount: 0, completedCount: 0, createdAt: today, updatedAt: today,
    });
    const lease = new LeaseService(storage);
    const token = await lease.acquireLeaseWithToken(tenantId, accountId, 'worker', 60);
    const queue = new ActionQueueService({
      db: storage, leaseService: lease, budgetService: new BudgetService(storage),
      executor: new FakeExecutor(),
      resolveSafety: async (scheduled) => makeSafety('LIKE', scheduled.revisionId!),
    });

    const scheduled = await queue.scheduleAction(makeAction('like', 'budget-resume', 'https://fixture.test/budget-resume'));
    await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);
    expect(storage.getTable('scheduledActions').find((a) => a.id === scheduled.id)!.status).toBe('PAUSED_BUDGET');

    // New budget window rolls: budget restored and pause window passes
    const budget = storage.getTable('dailyActionBudgets').find((b) => b.id === 'budget-like-resume')!;
    budget.limit = 1;
    const stored = storage.getTable('scheduledActions').find((a) => a.id === scheduled.id)!;
    stored.scheduledFor = new Date(Date.now() - 1_000);

    const resumed = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);
    expect(resumed.processed).toBe(true);
    expect(resumed.result?.outcomeLabel).toBe('simulated');
    expect(storage.getTable('scheduledActions').find((a) => a.id === scheduled.id)!.status).toBe('COMPLETED');
  });

  it('resumePausedActions sweeps only mature PAUSED_BUDGET rows back to PENDING', async () => {
    const storage = new MemoryStorage();
    const now = new Date();
    const past = new Date(Date.now() - 1_000);
    const future = new Date(Date.now() + 60_000);
    storage.getTable('scheduledActions').push(
      { id: 'paused-mature', tenantId, accountId, prospectId, actionType: 'like', status: 'PAUSED_BUDGET', scheduledFor: past, errorCode: 'BUDGET_EXCEEDED', idempotencyKey: 'paused-mature', createdAt: now, updatedAt: now },
      { id: 'paused-immature', tenantId, accountId, prospectId, actionType: 'like', status: 'PAUSED_BUDGET', scheduledFor: future, errorCode: 'BUDGET_EXCEEDED', idempotencyKey: 'paused-immature', createdAt: now, updatedAt: now },
    );

    const resumed = await storage.resumePausedActions(tenantId);
    expect(resumed).toBe(1);

    const mature = storage.getTable('scheduledActions').find((a) => a.id === 'paused-mature')!;
    expect(mature.status).toBe('PENDING');
    expect(mature.errorCode).toBeUndefined();
    const immature = storage.getTable('scheduledActions').find((a) => a.id === 'paused-immature')!;
    expect(immature.status).toBe('PAUSED_BUDGET');
  });

  it.each(['SELECTOR_MISMATCH', 'RATE_LIMITED', 'EXECUTION_TIMEOUT'])(
    'retries %s with attemptCount increments up to the ceiling, then dead-letters to FAILED',
    async (errorCode) => {
      const storage = new MemoryStorage();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      storage.getTable('dailyActionBudgets').push({
        id: 'budget-like-retry', tenantId, accountId, actionType: 'like', budgetDate: today,
        limit: 5, reservedCount: 0, completedCount: 0, createdAt: today, updatedAt: today,
      });
      const lease = new LeaseService(storage);
      const token = await lease.acquireLeaseWithToken(tenantId, accountId, 'worker', 60);
      const failingExecutor: any = {
        likePost: async () => ({ success: false, errorCode, timestamp: new Date().toISOString() }),
      };
      const queue = new ActionQueueService({
        db: storage, leaseService: lease, budgetService: new BudgetService(storage),
        executor: failingExecutor,
        resolveSafety: async (scheduled) => makeSafety('LIKE', scheduled.revisionId!),
      });

      const scheduled = await queue.scheduleAction(makeAction('like', `retry-${errorCode}`));

      // Attempt 1 → retry scheduled with attemptCount 1 and backoff
      let result = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);
      expect(result.reason).toBe('RETRY_SCHEDULED');
      let stored = storage.getTable('scheduledActions').find((a) => a.id === scheduled.id)!;
      expect(stored.status).toBe('PENDING');
      expect(stored.attemptCount).toBe(1);
      expect(stored.errorCode).toBe(errorCode);
      expect(stored.scheduledFor.getTime()).toBeGreaterThan(Date.now()); // backoff applied

      // Simulate the 5-minute backoff elapsing
      stored.scheduledFor = new Date(Date.now() - 1_000);

      // Attempt 2 → retry scheduled with attemptCount 2
      result = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);
      expect(result.reason).toBe('RETRY_SCHEDULED');
      stored = storage.getTable('scheduledActions').find((a) => a.id === scheduled.id)!;
      expect(stored.attemptCount).toBe(2);
      stored.scheduledFor = new Date(Date.now() - 1_000);

      // Attempt 3 → ceiling reached → dead-letter FAILED
      result = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);
      expect(result.reason).toBe('EXECUTION_FAILED');
      stored = storage.getTable('scheduledActions').find((a) => a.id === scheduled.id)!;
      expect(stored.status).toBe('FAILED');
      expect(stored.attemptCount).toBe(2);

      // No further pending work remains (bounded, no infinite loop)
      const final = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);
      expect(final.reason).toBe('NO_PENDING_ACTIONS');
    },
  );

  it('fails COOLDOWN_ACTIVE directly with 0 retries (fast failure, no attemptCount increment)', async () => {
    const storage = new MemoryStorage();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    storage.getTable('dailyActionBudgets').push({
      id: 'budget-like-cooldown', tenantId, accountId, actionType: 'like', budgetDate: today,
      limit: 5, reservedCount: 0, completedCount: 0, createdAt: today, updatedAt: today,
    });
    // Recent LIKE history → cooldown active for this prospect
    storage.getTable('engagementHistory').push({
      id: 'history-cooldown-1', tenantId, prospectId, postId: 'post-1',
      actionType: 'LIKE', interactedAt: new Date(), operatorId: 'worker',
    });
    const lease = new LeaseService(storage);
    const token = await lease.acquireLeaseWithToken(tenantId, accountId, 'worker', 60);
    const queue = new ActionQueueService({
      db: storage, leaseService: lease, budgetService: new BudgetService(storage),
      executor: new FakeExecutor(),
      resolveSafety: async (scheduled) => makeSafety('LIKE', scheduled.revisionId!),
    });

    const scheduled = await queue.scheduleAction(makeAction('like', 'cooldown-fast-fail'));
    const result = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);

    expect(result.reason).toBe('COOLDOWN_ACTIVE');
    const stored = storage.getTable('scheduledActions').find((a) => a.id === scheduled.id)!;
    expect(stored.status).toBe('FAILED');
    expect(stored.errorCode).toBe('COOLDOWN_ACTIVE');
    expect(stored.attemptCount ?? 0).toBe(0); // no retries for policy refusals

    const next = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);
    expect(next.reason).toBe('NO_PENDING_ACTIONS');
  });
});
