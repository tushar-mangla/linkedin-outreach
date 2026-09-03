import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SafetyGate } from '../src/core/safety-gate';
import { db } from '../src/db';
import { approvals, scheduledActions, sequenceSteps } from '../src/db/schema';

vi.mock('../src/db', () => {
    const mockDb = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn(),
    };
    return { db: mockDb };
});

const { db: mockDb } = await import('../src/db');

describe('SafetyGate', () => {
  const tenantId = 'test-tenant-id';
  const scheduledActionId = 'test-action-id';
  const sequenceStepId = 'test-step-id';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should pass checks if dryRun is true', async () => {
    const gate = new SafetyGate({ tenantId, scheduledActionId, isDryRun: true });
    await expect(gate.check()).resolves.toBeUndefined();
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('should throw an error if the scheduled action is not found', async () => {
    mockDb.from.mockReturnValue({ where: vi.fn().mockResolvedValue([]) } as any);
    const gate = new SafetyGate({ tenantId, scheduledActionId, isDryRun: false });
    await expect(gate.check()).rejects.toThrow(
      `[SafetyGate] Scheduled action ${scheduledActionId} not found.`
    );
  });

  it('should pass if an action does not require approval', async () => {
    const mockAction = { id: scheduledActionId, sequenceStepId, tenantId };
    const mockStep = { id: sequenceStepId, actionType: 'CONNECTION_REQUEST' };

    mockDb.from.mockImplementation((table: any) => {
        if (table === scheduledActions) {
            return { where: vi.fn().mockResolvedValue([mockAction]) };
        }
        if (table === sequenceSteps) {
            return { where: vi.fn().mockResolvedValue([mockStep]) };
        }
        return { where: vi.fn().mockResolvedValue([]) };
    });

    const gate = new SafetyGate({ tenantId, scheduledActionId, isDryRun: false });
    await expect(gate.check()).resolves.toBeUndefined();
  });

  it('should throw an error if a required approval is missing', async () => {
    const mockAction = { id: scheduledActionId, sequenceStepId, tenantId };
    const mockStep = { id: sequenceStepId, actionType: 'MESSAGE' };

    mockDb.from.mockImplementation((table: any) => {
        if (table === scheduledActions) return { where: vi.fn().mockResolvedValue([mockAction]) };
        if (table === sequenceSteps) return { where: vi.fn().mockResolvedValue([mockStep]) };
        if (table === approvals) return { where: vi.fn().mockResolvedValue([]) }; // No approval
        return { where: vi.fn().mockResolvedValue([]) };
    });

    const gate = new SafetyGate({ tenantId, scheduledActionId, isDryRun: false });
    await expect(gate.check()).rejects.toThrow(
      `[SafetyGate] Action ${scheduledActionId} requires approval but is not approved.`
    );
  });

  it('should throw an error if a required approval is not in "approved" status', async () => {
    const mockAction = { id: scheduledActionId, sequenceStepId, tenantId };
    const mockStep = { id: sequenceStepId, actionType: 'MESSAGE' };
    const mockApproval = { resourceId: scheduledActionId, status: 'pending' };

    mockDb.from.mockImplementation((table: any) => {
        if (table === scheduledActions) return { where: vi.fn().mockResolvedValue([mockAction]) };
        if (table === sequenceSteps) return { where: vi.fn().mockResolvedValue([mockStep]) };
        if (table === approvals) return { where: vi.fn().mockResolvedValue([mockApproval]) };
        return { where: vi.fn().mockResolvedValue([]) };
    });

    const gate = new SafetyGate({ tenantId, scheduledActionId, isDryRun: false });
    await expect(gate.check()).rejects.toThrow(
      `[SafetyGate] Action ${scheduledActionId} requires approval but is not approved.`
    );
  });

  it('should pass if a required approval is present and approved', async () => {
    const mockAction = { id: scheduledActionId, sequenceStepId, tenantId };
    const mockStep = { id: sequenceStepId, actionType: 'MESSAGE' };
    const mockApproval = { resourceId: scheduledActionId, status: 'approved' };

    mockDb.from.mockImplementation((table: any) => {
        if (table === scheduledActions) return { where: vi.fn().mockResolvedValue([mockAction]) };
        if (table === sequenceSteps) return { where: vi.fn().mockResolvedValue([mockStep]) };
        if (table === approvals) return { where: vi.fn().mockResolvedValue([mockApproval]) };
        return { where: vi.fn().mockResolvedValue([]) };
    });

    const gate = new SafetyGate({ tenantId, scheduledActionId, isDryRun: false });
    await expect(gate.check()).resolves.toBeUndefined();
  });
});
