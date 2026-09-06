import { describe, expect, it } from 'vitest';
import { isWithinWorkingHours, redactForAudit, contentHash } from './safety-resolver.js';
import { assertActionSafe } from './engagement/execution-contracts.js';

function basePolicy(overrides = {}) {
  return {
    likeEnabled: true, commentEnabled: true, feature05BrowserEnabled: false,
    pilotActionsRemaining: 4, killSwitchActive: false, accountPaused: false,
    sessionHealthy: true, cooldownActive: false, budgetAvailable: true,
    leaseValid: true, workingHours: true, ...overrides,
  };
}

describe('fail-closed safety policy', () => {
  it('requires tenant, readiness, eligibility, and current approval', () => {
    const base = { tenantId: 't', prospectReady: true, postEligible: true, approvalCurrent: true, actionType: 'LIKE' as const, mode: 'SIMULATE' as const, policy: basePolicy() };
    expect(() => assertActionSafe({ ...base, tenantId: '' })).toThrow('TENANT_CONTEXT_REQUIRED');
    expect(() => assertActionSafe({ ...base, prospectReady: false })).toThrow('PROSPECT_NOT_READY');
    expect(() => assertActionSafe({ ...base, postEligible: false })).toThrow('POST_NOT_ELIGIBLE');
    expect(() => assertActionSafe({ ...base, approvalCurrent: false })).toThrow('APPROVAL_REQUIRED');
  });

  it('keeps like and comment independently enabled', () => {
    const likeOnly = basePolicy({ commentEnabled: false });
    expect(() => assertActionSafe({ tenantId: 't', prospectReady: true, postEligible: true, approvalCurrent: true, actionType: 'LIKE', mode: 'SIMULATE', policy: likeOnly })).not.toThrow();
    expect(() => assertActionSafe({ tenantId: 't', prospectReady: true, postEligible: true, approvalCurrent: true, actionType: 'COMMENT', mode: 'SIMULATE', policy: likeOnly })).toThrow('COMMENT_DISABLED');
  });

  it('fails closed on kill switch, lease, budget, cooldown, session, hours, pilot', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['KILL_SWITCH_ACTIVE', { killSwitchActive: true }],
      ['LEASE_UNAVAILABLE', { leaseValid: false }],
      ['BUDGET_EXCEEDED', { budgetAvailable: false }],
      ['COOLDOWN_ACTIVE', { cooldownActive: true }],
      ['SESSION_EXPIRED', { sessionHealthy: false }],
      ['OUTSIDE_WORKING_HOURS', { workingHours: false }],
      ['ACCOUNT_PAUSED', { accountPaused: true }],
      ['PILOT_CAP_REACHED', { pilotActionsRemaining: 0 }],
      ['FEATURE_05_BROWSER_DISABLED', { feature05BrowserEnabled: false }],
    ];
    for (const [code, override] of cases) {
      const mode = code === 'FEATURE_05_BROWSER_DISABLED' ? 'BROWSER' : 'SIMULATE';
      expect(() => assertActionSafe({ tenantId: 't', prospectReady: true, postEligible: true, approvalCurrent: true, actionType: 'LIKE', mode: mode as 'SIMULATE' | 'BROWSER', policy: basePolicy(override) })).toThrow(code);
    }
  });

  it('redacts secrets and hashes content deterministically', () => {
    expect(contentHash('abc')).toHaveLength(64);
    const redacted = redactForAudit({ token: 'abcdef1234567890abcdef', nested: { cookie: 'session=xyz' }, postUrl: 'https://fixture.test/x' });
    expect(JSON.stringify(redacted)).not.toContain('abcdef1234567890abcdef');
    expect(JSON.stringify(redacted)).toContain('https://fixture.test/x');
  });

  it('evaluates working hours without throwing', () => {
    expect(typeof isWithinWorkingHours(new Date('2026-01-05T12:00:00Z'), 'UTC')).toBe('boolean');
  });
});
