import type { DBAdapter } from '../../db/db-adapter.js';
import type { EngagerTarget } from '../../types.js';
import { normalizeLinkedinUrl } from '../icp/url-normalizer.js';
import { ENGAGER_TARGET_SEEDS } from './engager-target-seeds.js';

/**
 * Channel 5 — tenant-scoped target registry service.
 *
 * Responsibilities:
 * - List the tenant's targets, optionally active-only.
 * - Idempotently seed the reviewed default registry. Re-seeding inserts only
 *   missing (tenantId, normalizedUrl) records; it never renames an existing
 *   target or reactivates one an operator deactivated.
 * - Toggle a single target active/inactive without touching prospects or the
 *   native action queue.
 */
export class EngagerTargetRegistry {
  private readonly db: DBAdapter;

  constructor(db: DBAdapter) {
    this.db = db;
  }

  async list(tenantId: string, opts?: { activeOnly?: boolean }): Promise<EngagerTarget[]> {
    return this.db.listEngagerTargets(tenantId, opts);
  }

  async findById(tenantId: string, targetId: string): Promise<EngagerTarget | undefined> {
    return this.db.findEngagerTargetById(tenantId, targetId);
  }

  /**
   * Idempotent per-tenant seed of the 11 reviewed targets. Returns how many
   * records were created and how many already existed so operators can confirm
   * a re-seed is a no-op for their selection state.
   */
  async seed(tenantId: string): Promise<{ created: number; existing: number; targets: EngagerTarget[] }> {
    let created = 0;
    let existing = 0;
    const targets: EngagerTarget[] = [];

    for (const seed of ENGAGER_TARGET_SEEDS) {
      const normalizedUrl = normalizeLinkedinUrl(seed.linkedinUrl);
      const current = (await this.db.listEngagerTargets(tenantId)).find(t => t.normalizedUrl === normalizedUrl);
      if (current) {
        existing += 1;
        targets.push(current);
        continue;
      }
      const inserted = await this.db.upsertEngagerTarget({
        tenantId,
        targetType: seed.targetType,
        displayName: seed.displayName,
        linkedinUrl: seed.linkedinUrl,
        normalizedUrl,
      });
      created += 1;
      targets.push(inserted);
    }

    return { created, existing, targets };
  }

  async setActive(tenantId: string, targetId: string, isActive: boolean): Promise<EngagerTarget> {
    const updated = await this.db.updateEngagerTargetActive(tenantId, targetId, isActive);
    if (!updated) throw new Error('TARGET_NOT_FOUND');
    return updated;
  }
}