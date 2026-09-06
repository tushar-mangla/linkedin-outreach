import { describe, expect, it } from 'vitest';
import { MemoryStorage, TERMINAL_SCHEDULED_ACTION_STATUSES } from './memory-storage.js';

describe('MemoryStorage manual task lifecycle', () => {
  it('keeps task creation pending and labels explicit completion as manual-confirmed', async () => {
    const storage = new MemoryStorage();
    const pending = await storage.createManualTask({ tenantId: 'tenant-a', scheduledActionId: 'action-a', actionType: 'LIKE' });
    expect(pending.status).toBe('PENDING_CONFIRMATION');
    const completed = await storage.completeManualTask('tenant-a', pending.id, 'COMPLETED', 'operator-a', { checked: true });
    expect(completed).toEqual({ status: 'COMPLETED', outcomeLabel: 'manual-confirmed' });
    await expect(storage.completeManualTask('tenant-a', pending.id, 'COMPLETED', 'operator-a')).rejects.toThrow('MANUAL_TASK_TERMINAL');
  });

  it('does not treat failed or uncertain manual outcomes as verified success', async () => {
    const storage = new MemoryStorage();
    const pending = await storage.createManualTask({ tenantId: 'tenant-b', scheduledActionId: 'action-b', actionType: 'COMMENT' });
    const uncertain = await storage.completeManualTask('tenant-b', pending.id, 'UNCERTAIN', 'operator-b');
    expect(uncertain.outcomeLabel).toBe('uncertain');
  });
});

describe('MemoryStorage terminal-state immutability', () => {
  const terminals = ['COMPLETED', 'FAILED', 'CANCELLED', 'UNCERTAIN'] as const;
  const targets = ['PENDING', 'CLAIMED', 'COMPLETED', 'FAILED', 'CANCELLED', 'UNCERTAIN'] as const;

  it('exports the full terminal status set', () => {
    expect([...TERMINAL_SCHEDULED_ACTION_STATUSES].sort()).toEqual(['CANCELLED', 'COMPLETED', 'FAILED', 'UNCERTAIN']);
  });

  it.each(terminals)('rejects every update out of terminal state %s via updateScheduledActionStatus', async (terminal) => {
    const storage = new MemoryStorage();
    const action = await storage.insertScheduledAction({
      tenantId: 'tenant-t', prospectId: 'prospect-t', accountId: 'account-t',
      actionType: 'like', scheduledFor: new Date(), idempotencyKey: `key-${terminal}`,
    });
    await storage.updateScheduledActionStatus(action.id, terminal as never);
    for (const target of targets) {
      await expect(storage.updateScheduledActionStatus(action.id, target as never)).rejects.toThrow('TERMINAL_STATE_IMMUTABLE');
    }
  });

  it.each(terminals)('rejects every update out of terminal state %s via updateScheduledActionResult', async (terminal) => {
    const storage = new MemoryStorage();
    const action = await storage.insertScheduledAction({
      tenantId: 'tenant-t', prospectId: 'prospect-t', accountId: 'account-t',
      actionType: 'like', scheduledFor: new Date(), idempotencyKey: `result-key-${terminal}`,
    });
    await storage.updateScheduledActionResult('tenant-t', action.id, { status: terminal as never });
    for (const target of targets) {
      await expect(storage.updateScheduledActionResult('tenant-t', action.id, { status: target as never })).rejects.toThrow('TERMINAL_STATE_IMMUTABLE');
    }
  });

  it('still allows non-terminal transitions', async () => {
    const storage = new MemoryStorage();
    const action = await storage.insertScheduledAction({
      tenantId: 'tenant-t', prospectId: 'prospect-t', accountId: 'account-t',
      actionType: 'like', scheduledFor: new Date(), idempotencyKey: 'non-terminal-key',
    });
    await storage.updateScheduledActionStatus(action.id, 'CLAIMED');
    const result = await storage.updateScheduledActionResult('tenant-t', action.id, { status: 'COMPLETED', outcomeLabel: 'simulated' });
    expect(result?.status).toBe('COMPLETED');
  });
});
