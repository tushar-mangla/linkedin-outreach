import { z } from 'zod';

export const ActionModeSchema = z.enum(['SIMULATE', 'MANUAL', 'BROWSER']);
export const ActionTypeSchema = z.enum(['LIKE', 'COMMENT']);
export const OutcomeLabelSchema = z.enum(['pending', 'simulated', 'manual-confirmed', 'browser-executed', 'verified', 'uncertain', 'refused', 'failed']);

export const SanitizedExecutionErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().default(false),
});

export const ActionRequestSchema = z.object({
  actionType: ActionTypeSchema,
  accountId: z.string().uuid(),
  mode: ActionModeSchema,
  idempotencyKey: z.string().min(1).max(255),
}).strict();

export type ActionMode = z.infer<typeof ActionModeSchema>;
export type EngagementActionType = z.infer<typeof ActionTypeSchema>;
export type OutcomeLabel = z.infer<typeof OutcomeLabelSchema>;

export interface IndependentActionPolicy {
  likeEnabled: boolean;
  commentEnabled: boolean;
  feature05BrowserEnabled: boolean;
  pilotActionsRemaining: number;
  killSwitchActive: boolean;
  accountPaused: boolean;
  sessionHealthy: boolean;
  cooldownActive: boolean;
  budgetAvailable: boolean;
  leaseValid: boolean;
  workingHours: boolean;
}

export interface SafetyActionInput {
  tenantId: string;
  prospectReady: boolean;
  postEligible: boolean;
  approvalCurrent: boolean;
  actionType: EngagementActionType;
  mode: ActionMode;
  policy: IndependentActionPolicy;
  revisionId?: string;
  postHash?: string;
}

export class SafetyGateError extends Error {
  constructor(public readonly code: string, message = code) {
    super(message);
    this.name = 'SafetyGateError';
  }
}

export function assertActionSafe(input: SafetyActionInput): void {
  if (!input.tenantId) throw new SafetyGateError('TENANT_CONTEXT_REQUIRED');
  if (!input.prospectReady) throw new SafetyGateError('PROSPECT_NOT_READY');
  if (!input.postEligible) throw new SafetyGateError('POST_NOT_ELIGIBLE');
  if (!input.approvalCurrent) throw new SafetyGateError('APPROVAL_REQUIRED');
  if (input.actionType === 'LIKE' && !input.policy.likeEnabled) throw new SafetyGateError('LIKE_DISABLED');
  if (input.actionType === 'COMMENT' && !input.policy.commentEnabled) throw new SafetyGateError('COMMENT_DISABLED');
  if (input.mode === 'BROWSER' && !input.policy.feature05BrowserEnabled) throw new SafetyGateError('FEATURE_05_BROWSER_DISABLED');
  if (input.policy.killSwitchActive) throw new SafetyGateError('KILL_SWITCH_ACTIVE');
  if (input.policy.accountPaused) throw new SafetyGateError('ACCOUNT_PAUSED');
  if (!input.policy.sessionHealthy) throw new SafetyGateError('SESSION_EXPIRED');
  if (input.policy.cooldownActive) throw new SafetyGateError('COOLDOWN_ACTIVE');
  if (!input.policy.budgetAvailable) throw new SafetyGateError('BUDGET_EXCEEDED');
  if (!input.policy.leaseValid) throw new SafetyGateError('LEASE_UNAVAILABLE');
  if (!input.policy.workingHours) throw new SafetyGateError('OUTSIDE_WORKING_HOURS');
  if (input.policy.pilotActionsRemaining <= 0) throw new SafetyGateError('PILOT_CAP_REACHED');
}
