import { db as defaultDb } from '../db/index.js';
import { scheduledActions } from '../db/schema.js';
import { recordAuditEvent } from './audit.js';
import { InferSelectModel, eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';

export type ScheduledAction = InferSelectModel<typeof scheduledActions>;

export interface ExecutionResult {
  success: boolean;
  message: string;
  details?: Record<string, any>;
}

export interface ActionExecutor {
  execute(action: ScheduledAction): Promise<ExecutionResult>;
}

export class FakeActionExecutor implements ActionExecutor {
  private tenantId: string;
  private db: typeof defaultDb;

  constructor(tenantId: string, db: typeof defaultDb = defaultDb) {
    this.tenantId = tenantId;
    this.db = db;
  }

  async execute(action: ScheduledAction): Promise<ExecutionResult> {
    console.log(`[FakeExecutor] Simulating execution for action: ${action.id}`);
    
    const result: ExecutionResult = {
      success: true,
      message: `Successfully simulated action ${action.id}.`,
      details: {
        simulatedAt: new Date().toISOString(),
      },
    };

    await recordAuditEvent({
      id: randomUUID(),
      tenantId: action.tenantId,
      event_type: 'action.executed.simulated',
      payload: {
        scheduledActionId: action.id,
        result,
      },
    }, this.db);

    await this.db.update(scheduledActions)
      .set({
        status: 'completed',
        executedAt: new Date(),
        executionResult: result,
      })
      .where(and(
        eq(scheduledActions.id, action.id),
        eq(scheduledActions.tenantId, this.tenantId)
      ));

    console.log(`[FakeExecutor] Simulation complete for action: ${action.id}`);
    return result;
  }
}
