
import { SQL, eq } from 'drizzle-orm';
import { PgTableWithColumns } from 'drizzle-orm/pg-core';
import { tenantContext } from '../tenant-context.js';

export function withTenant<T extends PgTableWithColumns<any>>(table: T) {
  const store = tenantContext.getStore();
  if (!store) {
    throw new Error('Tenant context is not available');
  }
  return eq(table.tenantId, store.tenantId);
}

export function tenantFilter<T extends PgTableWithColumns<any>>(table: T): SQL {
    const store = tenantContext.getStore();
    if (!store) {
      throw new Error('Tenant context is not available');
    }
    return eq(table.tenantId, store.tenantId);
}
