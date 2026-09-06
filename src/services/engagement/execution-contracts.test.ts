import { describe, expect, it } from 'vitest';
import { ActionRequestSchema, assertActionSafe, SafetyGateError, OutcomeLabelSchema } from './execution-contracts.js';

const policy = {
  likeEnabled: true,
  commentEnabled: false,
  feature05BrowserEnabled: false,
  pilotActionsRemaining: 4,
  killSwitchActive: false,
  accountPaused: false,
  sessionHealthy: true,
  cooldownActive: false,
  budgetAvailable: true,
  leaseValid: true,
  workingHours: true,
};

describe('supervised execution contracts', () => {
  it('validates action requests without allowing client authorization fields', () => {
    expect(ActionRequestSchema.parse({ actionType: 'LIKE', accountId: '00000000-0000-0000-0000-000000000001', mode: 'SIMULATE', idempotencyKey: 'one' })).toEqual({
      actionType: 'LIKE', accountId: '00000000-0000-0000-0000-000000000001', mode: 'SIMULATE', idempotencyKey: 'one',
    });
  });

  it('keeps comment disabled independently from like', () => {
    expect(() => assertActionSafe({ tenantId: 'tenant', prospectReady: true, postEligible: true, approvalCurrent: true, actionType: 'LIKE', mode: 'SIMULATE', policy })).not.toThrow();
    expect(() => assertActionSafe({ tenantId: 'tenant', prospectReady: true, postEligible: true, approvalCurrent: true, actionType: 'COMMENT', mode: 'SIMULATE', policy })).toThrowError(new SafetyGateError('COMMENT_DISABLED'));
  });

  it('blocks browser mode until Feature 0.5 is explicitly enabled', () => {
    expect(() => assertActionSafe({ tenantId: 'tenant', prospectReady: true, postEligible: true, approvalCurrent: true, actionType: 'LIKE', mode: 'BROWSER', policy })).toThrowError(new SafetyGateError('FEATURE_05_BROWSER_DISABLED'));
  });

  it('fails closed on kill switch and exhausted pilot', () => {
    expect(() => assertActionSafe({ tenantId: 'tenant', prospectReady: true, postEligible: true, approvalCurrent: true, actionType: 'LIKE', mode: 'SIMULATE', policy: { ...policy, killSwitchActive: true } })).toThrowError(new SafetyGateError('KILL_SWITCH_ACTIVE'));
    expect(() => assertActionSafe({ tenantId: 'tenant', prospectReady: true, postEligible: true, approvalCurrent: true, actionType: 'LIKE', mode: 'SIMULATE', policy: { ...policy, pilotActionsRemaining: 0 } })).toThrowError(new SafetyGateError('PILOT_CAP_REACHED'));
  });

  it('keeps browser execution distinct from verification and supports uncertainty', () => {
    expect(OutcomeLabelSchema.parse('browser-executed')).toBe('browser-executed');
    expect(OutcomeLabelSchema.parse('uncertain')).toBe('uncertain');
    expect(OutcomeLabelSchema.parse('verified')).toBe('verified');
  });

  it('rejects caller-supplied authorization fields', () => {
    expect(() => ActionRequestSchema.parse({ actionType: 'LIKE', accountId: '00000000-0000-0000-0000-000000000001', mode: 'SIMULATE', idempotencyKey: 'one', tenantId: 'forged' })).toThrow();
  });
});
