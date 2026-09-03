
export interface BudgetStorageAdapter {
    reserveBudget(tenantId: string, accountId: string, actionType: string, budgetDate: Date): Promise<string | undefined>;
    commitAction(reservationId: string): Promise<void>;
    releaseBudget(reservationId: string): Promise<void>;
}
