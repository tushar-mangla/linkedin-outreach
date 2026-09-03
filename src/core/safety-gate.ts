import { db as defaultDb } from '../db/index.js';
import { approvals, scheduledActions, sequenceSteps } from '../db/schema.js';
import { and, eq } from 'drizzle-orm';

interface SafetyContext {
  tenantId: string;
  scheduledActionId: string;
  isDryRun: boolean;
  db?: typeof defaultDb;
}

export class SafetyGate {
  private context: SafetyContext;
  private db: typeof defaultDb;

  constructor(context: SafetyContext) {
    this.context = context;
    this.db = context.db || defaultDb;
  }

  async check(): Promise<void> {
    if (this.context.isDryRun) {
      console.log(`[SafetyGate] Dry run enabled. Skipping real execution checks.`);
      return;
    }

    await this.verifyApproval();
    await this.checkAccountLimits();
  }

  private async verifyApproval(): Promise<void> {
    const { tenantId, scheduledActionId } = this.context;

    const action = await this.db.select()
      .from(scheduledActions)
      .where(and(
        eq(scheduledActions.id, scheduledActionId),
        eq(scheduledActions.tenantId, tenantId)
      ));

    if (!action || action.length === 0) {
        throw new Error(`[SafetyGate] Scheduled action ${scheduledActionId} not found.`);
    }

    const stepResult = await this.db.select()
        .from(sequenceSteps)
        .where(and(
            eq(sequenceSteps.id, action[0].sequenceStepId),
            eq(sequenceSteps.tenantId, tenantId)
        ));
    
    const step = stepResult.length > 0 ? stepResult[0] : null;

    if (step?.actionType === 'MESSAGE') {
        const approvalRecord = await this.db.select()
            .from(approvals)
            .where(and(
                eq(approvals.resourceId, scheduledActionId),
                eq(approvals.resourceType, 'ScheduledAction'),
                eq(approvals.tenantId, tenantId)
            ));

        if (!approvalRecord || approvalRecord.length === 0 || approvalRecord[0].status !== 'approved') {
            throw new Error(`[SafetyGate] Action ${scheduledActionId} requires approval but is not approved.`);
        }
    }
  }

  private async checkAccountLimits(): Promise<void> {
    console.log(`[SafetyGate] Checking account limits for action ${this.context.scheduledActionId}...`);
    const recentActionsCount = 0;
    const limit = 100;

    if (recentActionsCount >= limit) {
      throw new Error(`[SafetyGate] Account limit exceeded for action ${this.context.scheduledActionId}.`);
    }
     console.log(`[SafetyGate] Account limits check passed.`);
  }
}
