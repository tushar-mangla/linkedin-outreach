import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../db/memory-storage.js';
import { BudgetService } from './budget-service.js';
import { LeaseService } from './lease-service.js';
import { ActionQueueService } from './action-queue-service.js';
import { FakeExecutor } from '../executors/fake.js';
import { ManualExecutor } from '../executors/manual.js';

const tenantId = '00000000-0000-0000-0000-000000000001';
const accountId = '00000000-0000-0000-0000-000000000002';
const postHash = 'a'.repeat(64);

function action(actionType: 'like' | 'comment', key: string) {
  return {
    tenantId, prospectId: '00000000-0000-0000-0000-000000000003', accountId,
    actionType, payload: { postUrl: `https://fixture.test/${actionType}`, comment: 'Grounded comment' },
    scheduledFor: new Date(Date.now() - 1_000), idempotencyKey: key,
    revisionId: `revision-${actionType}`, postHash, mode: 'SIMULATE' as const,
  };
}

function safety(actionType: 'LIKE' | 'COMMENT', revisionId: string) {
  return {
    tenantId, prospectReady: true, postEligible: true, approvalCurrent: true, actionType,
    mode: 'SIMULATE' as const, revisionId, postHash,
    policy: { likeEnabled: actionType === 'LIKE', commentEnabled: actionType === 'COMMENT', feature05BrowserEnabled: false, pilotActionsRemaining: 4, killSwitchActive: false, accountPaused: false, sessionHealthy: true, cooldownActive: false, budgetAvailable: true, leaseValid: true, workingHours: true },
  };
}

describe('offline action queue', () => {
  it('dispatches Like and Comment independently and labels simulated outcomes', async () => {
    const storage = new MemoryStorage();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    storage.getTable('dailyActionBudgets').push(
      { id: 'budget-like', tenantId, accountId, actionType: 'like', budgetDate: today, limit: 2, reservedCount: 0, completedCount: 0, createdAt: today, updatedAt: today },
      { id: 'budget-comment', tenantId, accountId, actionType: 'comment', budgetDate: today, limit: 2, reservedCount: 0, completedCount: 0, createdAt: today, updatedAt: today },
    );
    const lease = new LeaseService(storage);
    const token = await lease.acquireLeaseWithToken(tenantId, accountId, 'worker', 60);
    const queue = new ActionQueueService({ db: storage, leaseService: lease, budgetService: new BudgetService(storage), executor: new FakeExecutor(), resolveSafety: async (scheduled) => safety(scheduled.actionType.toUpperCase() as 'LIKE' | 'COMMENT', scheduled.revisionId!) });

    const like = await queue.scheduleAction(action('like', 'like-once'));
    const comment = await queue.scheduleAction(action('comment', 'comment-once'));
    const first = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);
    const second = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);

    expect([first.result?.outcomeLabel, second.result?.outcomeLabel]).toEqual(['simulated', 'simulated']);
    expect(storage.getTable('scheduledActions').map(item => item.status)).toEqual(['COMPLETED', 'COMPLETED']);
    expect((await queue.scheduleAction(action('like', 'like-once'))).id).toBe(like.id);
    expect((await queue.scheduleAction(action('comment', 'comment-once'))).id).toBe(comment.id);
  });

  it('fails closed when trusted safety context is absent', async () => {
    const storage = new MemoryStorage();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    storage.getTable('dailyActionBudgets').push({ id: 'budget-like', tenantId, accountId, actionType: 'like', budgetDate: today, limit: 1, reservedCount: 0, completedCount: 0, createdAt: today, updatedAt: today });
    const lease = new LeaseService(storage);
    const token = await lease.acquireLeaseWithToken(tenantId, accountId, 'worker', 60);
    const queue = new ActionQueueService({ db: storage, leaseService: lease, budgetService: new BudgetService(storage), executor: new FakeExecutor(), resolveSafety: async () => undefined });
    await queue.scheduleAction(action('like', 'missing-safety'));
    const result = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);
    expect(result.reason).toBe('SAFETY_CONTEXT_REQUIRED');
    expect(storage.getTable('scheduledActions')[0].status).toBe('FAILED');
  });

  it('keeps manual-confirmation actions non-claimable until the manual task resolves', async () => {
    const storage = new MemoryStorage();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    storage.getTable('dailyActionBudgets').push({ id: 'budget-like', tenantId, accountId, actionType: 'like', budgetDate: today, limit: 1, reservedCount: 0, completedCount: 0, createdAt: today, updatedAt: today });
    const lease = new LeaseService(storage);
    const token = await lease.acquireLeaseWithToken(tenantId, accountId, 'worker', 60);
    const queue = new ActionQueueService({ db: storage, leaseService: lease, budgetService: new BudgetService(storage), executor: new ManualExecutor(), resolveSafety: async (scheduled) => safety(scheduled.actionType.toUpperCase() as 'LIKE' | 'COMMENT', scheduled.revisionId!) });
    await queue.scheduleAction(action('like', 'manual-once'));
    const result = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);
    expect(result.reason).toBe('EXECUTION_FAILED');
    // Action must NOT fall back to PENDING (re-claimable); it stays CLAIMED.
    expect(storage.getTable('scheduledActions')[0].status).toBe('CLAIMED');
    expect(storage.getTable('manualTasks')).toHaveLength(1);
    // No further pending work can be claimed while the manual task is open.
    const second = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);
    expect(second.reason).toBe('NO_PENDING_ACTIONS');
  });
});
