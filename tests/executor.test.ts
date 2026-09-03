import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FakeActionExecutor, ScheduledAction } from '../src/core/executor';
import { scheduledActions } from '../src/db/schema';

// Mock dependencies
vi.mock('../src/core/audit', () => ({
  recordAuditEvent: vi.fn(),
}));

vi.mock('../src/db', () => {
    const mockDb = {
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue({}),
    };
    return { db: mockDb };
});

// Dynamically import after mocks are set
const { db: mockDb } = await import('../src/db');
const audit = await import('../src/core/audit');

describe('FakeActionExecutor', () => {
  const tenantId = 'fake-tenant-id';
  const mockAction: ScheduledAction = {
    id: 'fake-action-id',
    tenantId: tenantId,
    enrollmentId: 'enroll-1',
    sequenceStepId: 'step-1',
    linkedInAccountId: 'li-acct-1',
    scheduledTime: new Date(),
    status: 'pending',
    executedAt: null,
    executionResult: null,
    createdAt: new Date(),
  };

  let executor: FakeActionExecutor;

  beforeEach(() => {
    executor = new FakeActionExecutor(tenantId, mockDb as any);
    vi.clearAllMocks();
  });

  it('should successfully simulate an action', async () => {
    const result = await executor.execute(mockAction);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Successfully simulated');
  });

  it('should record an audit event on execution', async () => {
    await executor.execute(mockAction);

    expect(audit.recordAuditEvent).toHaveBeenCalledOnce();
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: tenantId,
        event_type: 'action.executed.simulated',
        payload: expect.objectContaining({
          scheduledActionId: mockAction.id,
        }),
      }),
      mockDb as any
    );
  });

  it('should update the scheduled action status to "completed"', async () => {
    await executor.execute(mockAction);

    expect(mockDb.update).toHaveBeenCalledWith(scheduledActions);
    expect(mockDb.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        executionResult: expect.objectContaining({ success: true }),
      })
    );
    expect(mockDb.where).toHaveBeenCalled();
  });
});
