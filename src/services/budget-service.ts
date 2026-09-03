
import { BudgetStorageAdapter } from './budget-storage-adapter.js';

export class BudgetService {
  private storage: BudgetStorageAdapter;

  constructor(storage: BudgetStorageAdapter) {
    this.storage = storage;
  }

  public async reserveBudget(tenantId: string, accountId: string, actionType: string, budgetDate: Date): Promise<string | undefined> {
    return this.storage.reserveBudget(tenantId, accountId, actionType, budgetDate);
  }

  public async commitAction(reservationId: string): Promise<void> {
    await this.storage.commitAction(reservationId);
  }

  public async releaseBudget(reservationId: string): Promise<void> {
    await this.storage.releaseBudget(reservationId);
  }
}
