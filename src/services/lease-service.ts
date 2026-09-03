
import { v4 as uuidv4 } from 'uuid';
import { LeaseStorageAdapter } from './lease-storage-adapter.js';
import { AccountLease } from '../types.js';

export class LeaseService {
  private storage: LeaseStorageAdapter;

  constructor(storage: LeaseStorageAdapter) {
    this.storage = storage;
  }

  public async acquireLease(tenantId: string, accountId: string, workerId: string, ttlSeconds: number): Promise<boolean> {
    return this.storage.acquireLease(tenantId, accountId, workerId, ttlSeconds);
  }

  public async acquireLeaseWithToken(
    tenantId: string,
    accountId: string,
    workerId: string,
    ttlSeconds: number
  ): Promise<{ acquired: boolean; leaseToken?: string }> {
    const token = uuidv4();
    const acquired = await this.storage.acquireLease(tenantId, accountId, workerId, ttlSeconds, token);
    if (!acquired) {
      return { acquired: false };
    }
    return { acquired: true, leaseToken: token };
  }

  public async releaseLease(tenantId: string, accountId: string, workerId: string, leaseToken?: string): Promise<void> {
    await this.storage.releaseLease(tenantId, accountId, workerId, leaseToken);
  }

  public async heartbeatLease(
    tenantId: string,
    accountId: string,
    workerId: string,
    leaseToken: string,
    ttlSeconds: number
  ): Promise<boolean> {
    if (this.storage.heartbeatLease) {
      return this.storage.heartbeatLease(tenantId, accountId, workerId, leaseToken, ttlSeconds);
    }
    return false;
  }

  public async getActiveLease(tenantId: string, accountId: string): Promise<AccountLease | undefined> {
    if (this.storage.getActiveLease) {
      return this.storage.getActiveLease(tenantId, accountId);
    }
    return undefined;
  }

  public async recoverExpiredLeases(tenantId: string): Promise<void> {
    await this.storage.recoverExpiredLeases(tenantId);
  }
}

