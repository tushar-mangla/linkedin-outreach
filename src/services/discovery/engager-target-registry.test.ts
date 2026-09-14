import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../../db/memory-storage.js';
import { ENGAGER_TARGET_SEEDS } from './engager-target-seeds.js';
import { EngagerTargetRegistry } from './engager-target-registry.js';

describe('EngagerTargetRegistry (offline, MemoryStorage)', () => {
  it('seeds all 11 reviewed targets with canonical normalized URLs', async () => {
    const storage = new MemoryStorage();
    const registry = new EngagerTargetRegistry(storage);

    const result = await registry.seed('tenant-1');

    expect(result.created).toBe(11);
    expect(result.existing).toBe(0);
    expect(result.targets).toHaveLength(11);
    expect(result.targets.every(t => t.isActive)).toBe(true);
    expect(result.targets.every(t => t.normalizedUrl.startsWith('https://linkedin.com/'))).toBe(true);
    // 4 competitors + 7 influencers
    expect(result.targets.filter(t => t.targetType === 'COMPETITOR')).toHaveLength(4);
    expect(result.targets.filter(t => t.targetType === 'INFLUENCER')).toHaveLength(7);

    const mqa = result.targets.find(t => t.displayName === 'Michael Quinn Alexander');
    expect(mqa?.linkedinUrl).toBe('https://www.linkedin.com/in/michael-quinn-alexander/');
    expect(mqa?.normalizedUrl).toBe('https://linkedin.com/in/michael-quinn-alexander');
  });

  it('re-seeding is idempotent and does not duplicate', async () => {
    const storage = new MemoryStorage();
    const registry = new EngagerTargetRegistry(storage);

    const first = await registry.seed('tenant-1');
    const second = await registry.seed('tenant-1');

    expect(second.created).toBe(0);
    expect(second.existing).toBe(11);
    const targets = await registry.list('tenant-1');
    expect(targets).toHaveLength(11);
    expect(targets.map(t => t.id).sort()).toEqual(first.targets.map(t => t.id).sort());
  });

  it('re-seeding does not reactivate an operator-deactivated target', async () => {
    const storage = new MemoryStorage();
    const registry = new EngagerTargetRegistry(storage);

    await registry.seed('tenant-1');
    const targets = await registry.list('tenant-1');
    const target = targets[0];
    await registry.setActive('tenant-1', target.id, false);

    await registry.seed('tenant-1');

    const after = await registry.list('tenant-1');
    expect(after.find(t => t.id === target.id)?.isActive).toBe(false);
    expect(after).toHaveLength(11);
  });

  it('supports active-only listing and active toggling', async () => {
    const storage = new MemoryStorage();
    const registry = new EngagerTargetRegistry(storage);
    await registry.seed('tenant-1');

    const all = await registry.list('tenant-1');
    const inactive = all[0];
    await registry.setActive('tenant-1', inactive.id, false);

    const activeOnly = await registry.list('tenant-1', { activeOnly: true });
    expect(activeOnly).toHaveLength(10);
    expect(activeOnly.some(t => t.id === inactive.id)).toBe(false);
  });

  it('throws TARGET_NOT_FOUND for an unknown target toggle', async () => {
    const storage = new MemoryStorage();
    const registry = new EngagerTargetRegistry(storage);
    await expect(registry.setActive('tenant-1', 'missing-id', false)).rejects.toThrow('TARGET_NOT_FOUND');
  });

  it('isolates targets between tenants', async () => {
    const storage = new MemoryStorage();
    const registry = new EngagerTargetRegistry(storage);
    await registry.seed('tenant-a');

    const other = await registry.list('tenant-b');
    expect(other).toHaveLength(0);
    // A second tenant gets its own fresh seed set.
    const seeded = await registry.seed('tenant-b');
    expect(seeded.created).toBe(11);
    // Deactivating tenant-a does not affect tenant-b.
    const aTargets = await registry.list('tenant-a');
    await registry.setActive('tenant-a', aTargets[0].id, false);
    const bActive = await registry.list('tenant-b', { activeOnly: true });
    expect(bActive).toHaveLength(11);
  });

  it('never creates a target from an invalid URL (seed set is reviewed)', async () => {
    const storage = new MemoryStorage();
    const registry = new EngagerTargetRegistry(storage);
    await registry.seed('tenant-1');
    // All 11 seed URLs normalize without error and resolve to linkedin.com.
    for (const target of await registry.list('tenant-1')) {
      expect(target.normalizedUrl).toMatch(/^https:\/\/linkedin\.com\/(in|company)\//);
    }
    // The seed constants themselves are individually canonical.
    for (const seed of ENGAGER_TARGET_SEEDS) {
      expect(seed.displayName.trim().length).toBeGreaterThan(0);
      expect(seed.linkedinUrl).toMatch(/^https:\/\/www\.linkedin\.com\/(in|company)\//);
    }
  });
});