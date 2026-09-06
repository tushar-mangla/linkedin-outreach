import { describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../db/memory-storage.js';
import { BudgetService } from './budget-service.js';
import { LeaseService } from './lease-service.js';
import { ActionQueueService } from './action-queue-service.js';
import { FakeExecutor } from '../executors/fake.js';
import { ManualExecutor } from '../executors/manual.js';

const tenantId = '00000000-0000-0000-0000-000000000001';
const accountId = '00000000-0000-0000-0000-000000000002';
const postHash = 'c'.repeat(64);

function safetyOk(actionType: 'LIKE' | 'COMMENT', revisionId: string, overrides = {}) {
  return {
    tenantId, prospectReady: true, postEligible: true, approvalCurrent: true, actionType,
    mode: 'SIMULATE' as const, revisionId, postHash,
    policy: { likeEnabled: true, commentEnabled: true, feature05BrowserEnabled: false, pilotActionsRemaining: 4, killSwitchActive: false, accountPaused: false, sessionHealthy: true, cooldownActive: false, budgetAvailable: true, leaseValid: true, workingHours: true, ...overrides },
  };
}

describe('queue safety rechecks', () => {
  it('refuses dispatch on kill switch with durable failed state and audit', async () => {
    const storage = new MemoryStorage();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    storage.getTable('dailyActionBudgets').push({ id: 'b', tenantId, accountId, actionType: 'like', budgetDate: today, limit: 1, reservedCount: 0, completedCount: 0, createdAt: today, updatedAt: today });
    const lease = new LeaseService(storage);
    const token = await lease.acquireLeaseWithToken(tenantId, accountId, 'worker', 60);
    const queue = new ActionQueueService({
      db: storage, leaseService: lease, budgetService: new BudgetService(storage), executor: new FakeExecutor(),
      resolveSafety: async (scheduled) => safetyOk('LIKE', scheduled.revisionId!, { killSwitchActive: true }) as never,
    });
    await queue.scheduleAction({ tenantId, prospectId: 'p', accountId, actionType: 'like', payload: { postUrl: 'https://fixture.test/kill' }, scheduledFor: new Date(Date.now() - 1000), idempotencyKey: 'kill-1', revisionId: 'rev-kill', postHash, mode: 'SIMULATE' });
    const result = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);
    expect(result.reason).toBe('KILL_SWITCH_ACTIVE');
    expect(storage.getTable('scheduledActions')[0].status).toBe('FAILED');
  });

  it('rejects stale lease tokens before claiming', async () => {
    const storage = new MemoryStorage();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    storage.getTable('dailyActionBudgets').push({ id: 'b', tenantId, accountId, actionType: 'like', budgetDate: today, limit: 1, reservedCount: 0, completedCount: 0, createdAt: today, updatedAt: today });
    const lease = new LeaseService(storage);
    await lease.acquireLeaseWithToken(tenantId, accountId, 'worker-a', 60);
    const queue = new ActionQueueService({
      db: storage, leaseService: lease, budgetService: new BudgetService(storage), executor: new FakeExecutor(),
      resolveSafety: async (scheduled) => safetyOk('LIKE', scheduled.revisionId!) as never,
    });
    await queue.scheduleAction({ tenantId, prospectId: 'p', accountId, actionType: 'like', payload: { postUrl: 'https://fixture.test/lease' }, scheduledFor: new Date(Date.now() - 1000), idempotencyKey: 'lease-1', revisionId: 'rev-lease', postHash, mode: 'SIMULATE' });
    const result = await queue.processNextAction(tenantId, accountId, 'worker-b', 'stale-token');
    expect(result.reason).toBe('INVALID_OR_EXPIRED_LEASE');
    expect(storage.getTable('scheduledActions')[0].status).toBe('PENDING');
  });

  it('creates a durable manual task and keeps it pending until explicit completion', async () => {
    const storage = new MemoryStorage();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    storage.getTable('dailyActionBudgets').push({ id: 'b', tenantId, accountId, actionType: 'like', budgetDate: today, limit: 1, reservedCount: 0, completedCount: 0, createdAt: today, updatedAt: today });
    const lease = new LeaseService(storage);
    const token = await lease.acquireLeaseWithToken(tenantId, accountId, 'worker', 60);
    const queue = new ActionQueueService({
      db: storage, leaseService: lease, budgetService: new BudgetService(storage), executor: new ManualExecutor(),
      resolveSafety: async (scheduled) => safetyOk('LIKE', scheduled.revisionId!) as never,
    });
    const scheduled = await queue.scheduleAction({ tenantId, prospectId: 'p', accountId, actionType: 'like', payload: { postUrl: 'https://fixture.test/manual' }, scheduledFor: new Date(Date.now() - 1000), idempotencyKey: 'manual-1', revisionId: 'rev-manual', postHash, mode: 'MANUAL' });
    const result = await queue.processNextAction(tenantId, accountId, 'worker', token.leaseToken);
    expect(result.result?.errorCode).toBe('MANUAL_CONFIRMATION_PENDING');
    const tasks = (storage as unknown as { getTable: (name: 'manualTasks') => Array<{ scheduledActionId: string; status: string }> }).getTable('manualTasks');
    expect(tasks.some(task => task.scheduledActionId === scheduled.id && task.status === 'PENDING_CONFIRMATION')).toBe(true);
  });

  it('treats terminal states as immutable', async () => {
    const storage = new MemoryStorage();
    const scheduled = await storage.insertScheduledAction({ tenantId, prospectId: 'p', accountId, actionType: 'like', payload: {}, scheduledFor: new Date(Date.now() - 1000), idempotencyKey: 'terminal-1', revisionId: 'r', postHash, mode: 'SIMULATE' });
    await storage.updateScheduledActionResult(tenantId, scheduled.id, { status: 'COMPLETED', outcomeLabel: 'simulated' });
    await expect(storage.updateScheduledActionStatus(scheduled.id, 'PENDING')).rejects.toThrow('TERMINAL_STATE_IMMUTABLE');
    expect(vi.fn().mock.calls.length).toBe(0);
  });
});
