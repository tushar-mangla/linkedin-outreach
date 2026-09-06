import { afterEach, describe, expect, it } from 'vitest';
import { resolveDevContext } from './request-context.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('trusted request context', () => {
  it('never accepts tenant or operator identity from request bodies', () => {
    process.env.DEV_AUTH_ENABLED = '1';
    process.env.SINGLE_USER_TENANT_ID = '00000000-0000-0000-0000-000000000001';
    const context = resolveDevContext();
    expect(context?.tenantId).toBe('00000000-0000-0000-0000-000000000001');
    expect(context?.operatorId).toBeTruthy();
    expect(context).not.toHaveProperty('tenantIdFromBody');
  });

  it('fails closed when dev auth is explicitly disabled', () => {
    process.env.DEV_AUTH_ENABLED = '0';
    expect(resolveDevContext()).toBeUndefined();
  });

  it('fails closed when DEV_AUTH_ENABLED is unset', () => {
    delete process.env.DEV_AUTH_ENABLED;
    expect(resolveDevContext()).toBeUndefined();
  });

  it('fails closed in production even when dev auth is enabled', () => {
    process.env.NODE_ENV = 'production';
    process.env.DEV_AUTH_ENABLED = '1';
    expect(resolveDevContext()).toBeUndefined();
  });

  it('resolves dev context only when explicitly enabled outside production', () => {
    process.env.NODE_ENV = 'test';
    process.env.DEV_AUTH_ENABLED = '1';
    process.env.SINGLE_USER_TENANT_ID = '00000000-0000-0000-0000-000000000001';
    expect(resolveDevContext()?.devAuth).toBe(true);
  });
});
