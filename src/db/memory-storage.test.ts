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

describe('MemoryStorage attemptCount and PAUSED_BUDGET (post-integrity remediation)', () => {
  it('round-trips attemptCount through insert, claim, and updateScheduledActionResult', async () => {
    const storage = new MemoryStorage();
    const action = await storage.insertScheduledAction({
      tenantId: 'tenant-ac', prospectId: 'prospect-ac', accountId: 'account-ac',
      actionType: 'like', scheduledFor: new Date(Date.now() - 1000), idempotencyKey: 'attempt-roundtrip',
    });
    expect(action.attemptCount).toBe(0); // schema default

    const claimed = await storage.claimNextScheduledAction('tenant-ac', 'account-ac', 'worker-1');
    expect(claimed?.attemptCount).toBe(0);

    const updated = await storage.updateScheduledActionResult('tenant-ac', action.id, {
      status: 'PENDING', errorCode: 'SELECTOR_MISMATCH', attemptCount: 1, scheduledFor: new Date(Date.now() + 300_000),
    });
    expect(updated?.attemptCount).toBe(1);
    expect(updated?.errorCode).toBe('SELECTOR_MISMATCH');
    expect(updated!.scheduledFor.getTime()).toBeGreaterThan(Date.now());
  });

  it('treats PAUSED_BUDGET as non-terminal and never claims it', async () => {
    expect(TERMINAL_SCHEDULED_ACTION_STATUSES).not.toContain('PAUSED_BUDGET');

    const storage = new MemoryStorage();
    const now = new Date();
    storage.getTable('scheduledActions').push({
      id: 'paused-not-claimable', tenantId: 'tenant-pb', accountId: 'account-pb', prospectId: 'prospect-pb',
      actionType: 'like', status: 'PAUSED_BUDGET', scheduledFor: new Date(Date.now() - 1000),
      errorCode: 'BUDGET_EXCEEDED', idempotencyKey: 'paused-not-claimable', createdAt: now, updatedAt: now,
    });

    // claimNextScheduledAction filters status = PENDING only → PAUSED_BUDGET is never claimed
    const claimed = await storage.claimNextScheduledAction('tenant-pb', 'account-pb', 'worker-1');
    expect(claimed).toBeUndefined();

    // Non-terminal: a PAUSED_BUDGET row can still transition (e.g. resume sweep)
    const resumed = await storage.updateScheduledActionResult('tenant-pb', 'paused-not-claimable', { status: 'PENDING', errorCode: undefined });
    expect(resumed?.status).toBe('PENDING');
  });
});

describe('MemoryStorage Channel 5 target registry (adapter parity)', () => {
  it('upserts only when (tenantId, normalizedUrl) is absent and never reactivates', async () => {
    const storage = new MemoryStorage();
    const first = await storage.upsertEngagerTarget({
      tenantId: 'tenant-c5', targetType: 'INFLUENCER', displayName: 'Greg Savage',
      linkedinUrl: 'https://www.linkedin.com/in/gregsavage/', normalizedUrl: 'https://linkedin.com/in/gregsavage',
    });
    expect(first.isActive).toBe(true);

    // Same canonical URL returns the existing row unchanged (idempotent seed).
    const again = await storage.upsertEngagerTarget({
      tenantId: 'tenant-c5', targetType: 'INFLUENCER', displayName: 'Renamed', 
      linkedinUrl: 'https://www.linkedin.com/in/gregsavage/other', normalizedUrl: 'https://linkedin.com/in/gregsavage',
    });
    expect(again.id).toBe(first.id);
    expect(again.displayName).toBe('Greg Savage');

    await storage.updateEngagerTargetActive('tenant-c5', first.id, false);
    const afterDeactivate = await storage.upsertEngagerTarget({
      tenantId: 'tenant-c5', targetType: 'INFLUENCER', displayName: 'Greg Savage',
      linkedinUrl: 'https://www.linkedin.com/in/gregsavage/', normalizedUrl: 'https://linkedin.com/in/gregsavage',
    });
    expect(afterDeactivate.id).toBe(first.id);
    expect(afterDeactivate.isActive).toBe(false);
  });

  it('lists active-only, isolated by tenant, and updates active state', async () => {
    const storage = new MemoryStorage();
    const a = await storage.upsertEngagerTarget({ tenantId: 'ta', targetType: 'COMPETITOR', displayName: 'Bullhorn', linkedinUrl: 'https://www.linkedin.com/company/bullhorn/', normalizedUrl: 'https://linkedin.com/company/bullhorn' });
    await storage.upsertEngagerTarget({ tenantId: 'tb', targetType: 'COMPETITOR', displayName: 'Loxo', linkedinUrl: 'https://www.linkedin.com/company/loxo/', normalizedUrl: 'https://linkedin.com/company/loxo' });

    expect(await storage.listEngagerTargets('ta')).toHaveLength(1);
    expect(await storage.listEngagerTargets('tb')).toHaveLength(1);

    await storage.updateEngagerTargetActive('ta', a.id, false);
    expect(await storage.listEngagerTargets('ta', { activeOnly: true })).toHaveLength(0);
    expect(await storage.listEngagerTargets('ta')).toHaveLength(1);

    const missing = await storage.updateEngagerTargetActive('ta', 'nope', true);
    expect(missing).toBeUndefined();
  });

  it('finds a target by tenant and id only within the tenant', async () => {
    const storage = new MemoryStorage();
    const a = await storage.upsertEngagerTarget({ tenantId: 'ta', targetType: 'INFLUENCER', displayName: 'Hung Lee', linkedinUrl: 'https://www.linkedin.com/in/hunglee/', normalizedUrl: 'https://linkedin.com/in/hunglee' });
    expect((await storage.findEngagerTargetById('ta', a.id))?.displayName).toBe('Hung Lee');
    expect(await storage.findEngagerTargetById('other-tenant', a.id)).toBeUndefined();
  });
});
