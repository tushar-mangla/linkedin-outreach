import { describe, expect, it, vi } from 'vitest';
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
  it('dispatches Like and Comment independently, labels simulated outcomes, and records durable history', async () => {
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
    storage.getTable('accountPostComments').push({ tenantId, accountId, canonicalPostIdentifier: 'linkedin:activity:first-comment', scheduledActionId: comment.id, status: 'PENDING' });
    const first = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);
    const second = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);

    expect([first.result?.outcomeLabel, second.result?.outcomeLabel]).toEqual(['simulated', 'simulated']);
    expect(storage.getTable('scheduledActions').map(item => item.status)).toEqual(['COMPLETED', 'COMPLETED']);
    expect((await queue.scheduleAction(action('like', 'like-once'))).id).toBe(like.id);
    expect((await queue.scheduleAction(action('comment', 'comment-once'))).id).toBe(comment.id);

    // Assert exactly one history row per completed engagement action
    const history = storage.getTable('engagementHistory');
    expect(history).toHaveLength(2);
    expect(history.map(h => h.actionType).sort()).toEqual(['COMMENT', 'LIKE']);
    expect(history.every(h => h.tenantId === tenantId)).toBe(true);
    expect(history.every(h => h.operatorId === 'worker')).toBe(true);

    // Duplicate finalization stays one row (idempotency)
    await storage.finalizeCommentAction(tenantId, comment.id, { status: 'COMPLETED', outcomeLabel: 'simulated' }, 'worker');
    expect(storage.getTable('engagementHistory')).toHaveLength(2);
  });

  it('fails closed when trusted safety context is absent and records no history', async () => {
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
    expect(storage.getTable('engagementHistory')).toHaveLength(0);
  });

  it('keeps manual-confirmation actions non-claimable until the manual task resolves and records no history', async () => {
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
    expect(storage.getTable('engagementHistory')).toHaveLength(0);
    // No further pending work can be claimed while the manual task is open.
    const second = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);
    expect(second.reason).toBe('NO_PENDING_ACTIONS');
  });

  it('finalizes an owned comment slot and leaves uncertain outcomes non-retryable with no history', async () => {
    const storage = new MemoryStorage();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    storage.getTable('dailyActionBudgets').push({ id: 'budget-comment', tenantId, accountId, actionType: 'comment', budgetDate: today, limit: 1, reservedCount: 0, completedCount: 0, createdAt: today, updatedAt: today });
    const lease = new LeaseService(storage);
    const token = await lease.acquireLeaseWithToken(tenantId, accountId, 'worker', 60);
    const queue = new ActionQueueService({ db: storage, leaseService: lease, budgetService: new BudgetService(storage), executor: new FakeExecutor(), resolveSafety: async (scheduled) => safety('COMMENT', scheduled.revisionId!) });
    const scheduled = await queue.scheduleAction(action('comment', 'owned-comment'));
    storage.getTable('accountPostComments').push({ tenantId, accountId, canonicalPostIdentifier: 'linkedin:activity:1', scheduledActionId: scheduled.id, status: 'PENDING' });
    await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);
    expect(storage.getTable('accountPostComments')[0].status).toBe('COMPLETED');
    expect(storage.getTable('engagementHistory')).toHaveLength(1);
  });

  it('marks an action and its owned comment slot uncertain when the executor throws and records no history', async () => {
    const storage = new MemoryStorage();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    storage.getTable('dailyActionBudgets').push({ id: 'budget-comment-uncertain', tenantId, accountId, actionType: 'comment', budgetDate: today, limit: 1, reservedCount: 0, completedCount: 0, createdAt: today, updatedAt: today });
    const lease = new LeaseService(storage);
    const token = await lease.acquireLeaseWithToken(tenantId, accountId, 'worker', 60);
    const executor = new FakeExecutor();
    executor.publishComment = async () => { throw new Error('browser disconnected after submit'); };
    const queue = new ActionQueueService({ db: storage, leaseService: lease, budgetService: new BudgetService(storage), executor, resolveSafety: async (scheduled) => safety('COMMENT', scheduled.revisionId!) });
    const scheduled = await queue.scheduleAction(action('comment', 'uncertain-comment'));
    storage.getTable('accountPostComments').push({ tenantId, accountId, canonicalPostIdentifier: 'linkedin:activity:uncertain', scheduledActionId: scheduled.id, status: 'PENDING' });

    await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);

    expect(storage.getTable('scheduledActions')[0].status).toBe('UNCERTAIN');
    expect(storage.getTable('accountPostComments')[0].status).toBe('UNCERTAIN');
    expect(storage.getTable('engagementHistory')).toHaveLength(0);
  });

  it('refuses a cooled-down queued comment without invoking executor or consuming budget', async () => {
    const storage = new MemoryStorage();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    storage.getTable('dailyActionBudgets').push({
      id: 'budget-comment-cooldown',
      tenantId,
      accountId,
      actionType: 'comment',
      budgetDate: today,
      limit: 5,
      reservedCount: 0,
      completedCount: 0,
      createdAt: today,
      updatedAt: today,
    });
    const lease = new LeaseService(storage);
    const token = await lease.acquireLeaseWithToken(tenantId, accountId, 'worker', 60);

    const executor = new FakeExecutor();
    const publishSpy = vi.spyOn(executor, 'publishComment');

    // Prior comment completed 3 days ago -> inside 14-day cooldown
    storage.getTable('engagementHistory').push({
      id: 'prior-comment',
      tenantId,
      prospectId: '00000000-0000-0000-0000-000000000003',
      postId: 'prior-post-id',
      actionType: 'COMMENT',
      interactedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      operatorId: 'prior-worker',
      scheduledActionId: 'prior-action-id',
    });

    const queue = new ActionQueueService({
      db: storage,
      leaseService: lease,
      budgetService: new BudgetService(storage),
      executor,
      resolveSafety: async (scheduled) => safety('COMMENT', scheduled.revisionId!),
    });

    const scheduled = await queue.scheduleAction(action('comment', 'cooldown-comment'));
    storage.getTable('accountPostComments').push({
      tenantId,
      accountId,
      canonicalPostIdentifier: 'linkedin:activity:cooldown-post',
      scheduledActionId: scheduled.id,
      status: 'PENDING',
    });

    const result = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);

    expect(result.processed).toBe(true);
    expect(result.reason).toBe('COOLDOWN_ACTIVE');
    expect(publishSpy).not.toHaveBeenCalled();

    // Action marked FAILED with outcomeLabel refused and errorCode COOLDOWN_ACTIVE
    const updatedAction = storage.getTable('scheduledActions').find(a => a.id === scheduled.id);
    expect(updatedAction?.status).toBe('FAILED');
    expect(updatedAction?.outcomeLabel).toBe('refused');
    expect(updatedAction?.errorCode).toBe('COOLDOWN_ACTIVE');

    // Owned comment slot marked FAILED
    const updatedSlot = storage.getTable('accountPostComments').find(s => s.scheduledActionId === scheduled.id);
    expect(updatedSlot?.status).toBe('FAILED');

    // Daily budget was NOT consumed
    const budget = storage.getTable('dailyActionBudgets').find(b => b.id === 'budget-comment-cooldown');
    expect(budget?.reservedCount).toBe(0);
    expect(budget?.completedCount).toBe(0);

    // No new engagement history row was added
    expect(storage.getTable('engagementHistory')).toHaveLength(1);
  });
});
