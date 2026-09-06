
import { AsyncLocalStorage } from 'async_hooks';

export interface TenantContextData {
  tenantId: string;
}

export const tenantContext = new AsyncLocalStorage<TenantContextData>();

export function requireTenantId(): string {
  const tenantId = tenantContext.getStore()?.tenantId ?? process.env.SINGLE_USER_TENANT_ID ?? '00000000-0000-0000-0000-000000000001';
  return tenantId;
}

export function assertTenantId(tenantId: string): void {
  if (requireTenantId() !== tenantId) {
    throw new Error('Tenant context does not match the requested tenant');
  }
}
