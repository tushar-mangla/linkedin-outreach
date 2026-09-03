
import { AsyncLocalStorage } from 'async_hooks';

export interface TenantContextData {
  tenantId: string;
}

export const tenantContext = new AsyncLocalStorage<TenantContextData>();

export function requireTenantId(): string {
  const tenantId = tenantContext.getStore()?.tenantId;
  if (!tenantId) {
    throw new Error('Tenant context is not available');
  }
  return tenantId;
}

export function assertTenantId(tenantId: string): void {
  if (requireTenantId() !== tenantId) {
    throw new Error('Tenant context does not match the requested tenant');
  }
}
