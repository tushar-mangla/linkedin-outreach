
import { assertActionSafe, SafetyActionInput } from './engagement/execution-contracts.js';

export class SafetyGate {
  public async isActionSafe(action: SafetyActionInput): Promise<boolean> {
    try {
      assertActionSafe(action);
      return true;
    } catch {
      return false;
    }
  }

  public assertActionSafe(action: SafetyActionInput): void {
    assertActionSafe(action);
  }
}
