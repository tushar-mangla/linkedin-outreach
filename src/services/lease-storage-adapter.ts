
import { AccountLease } from '../types.js';

export interface LeaseStorageAdapter {
    acquireLease(tenantId: string, accountId: string, workerId: string, ttlSeconds: number, leaseToken?: string): Promise<boolean>;
    acquireLeaseToken?(tenantId: string, accountId: string, workerId: string, ttlSeconds: number): Promise<string | null>;
    releaseLease(tenantId: string, accountId: string, workerId: string, leaseToken?: string): Promise<void>;
    heartbeatLease?(tenantId: string, accountId: string, workerId: string, leaseToken: string, ttlSeconds: number): Promise<boolean>;
    getActiveLease?(tenantId: string, accountId: string): Promise<AccountLease | undefined>;
    recoverExpiredLeases(tenantId: string): Promise<void>;
}

