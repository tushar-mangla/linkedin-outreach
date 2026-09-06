import { describe, expect, it } from 'vitest';
import type { ProspectInput } from '../../schemas/icp.js';
import { discoveryDedupeKey, ProspectDiscoveryService } from './prospect-discovery-service.js';

// Offline fixture: two distinct profiles plus an in-run duplicate. No network.
const FIXTURE_HTML = `
<html><body>
<div><a href="https://www.linkedin.com/in/alice-founder">Alice Founder - Founder at Alpha Search | LinkedIn</a></div>
<div><a href="https://www.linkedin.com/in/bob-director">Bob Director - Managing Director at Beta Talent | LinkedIn</a></div>
<div><a href="https://www.linkedin.com/in/ALICE-FOUNDER/">Alice Founder - Founder at Alpha Search | LinkedIn</a></div>
<div><a href="https://www.linkedin.com/company/alpha-search">Alpha Search | LinkedIn</a></div>
</body></html>`;

function buildService(hooks: {
  existing?: string[];
  ingested?: ProspectInput[][];
  stages?: { qualified: number; reviewRequired: number; disqualified: number };
}) {
  const ingested: ProspectInput[][] = hooks.ingested ?? [];
  const service = new ProspectDiscoveryService({
    searchHtml: async () => FIXTURE_HTML,
    findExisting: async (_tenantId, urls) => {
      const known = new Set((hooks.existing ?? []).map((u) => u.toLowerCase()));
      return new Set(urls.filter((u) => known.has(u.toLowerCase())));
    },
    ingest: async (_tenantId, _icpId, rows) => {
      ingested.push(rows);
    },
    countStages: async () => hooks.stages ?? { qualified: 1, reviewRequired: 1, disqualified: 0 },
  });
  return { service, ingested };
}

describe('discoveryDedupeKey', () => {
  it('canonicalizes equivalent URLs to one key and rejects garbage', () => {
    expect(discoveryDedupeKey('https://www.linkedin.com/in/Alice-Founder/?x=1')).toBe(
      discoveryDedupeKey('https://linkedin.com/in/alice-founder'),
    );
    expect(discoveryDedupeKey('not-a-url')).toBeNull();
  });
});

describe('ProspectDiscoveryService (offline, injected seams)', () => {
  it('dedupes in-run and against existing prospects, then ingests only fresh rows', async () => {
    const { service, ingested } = buildService({
      existing: ['https://linkedin.com/in/bob-director'],
      stages: { qualified: 1, reviewRequired: 0, disqualified: 0 },
    });

    const report = await service.discover('tenant-1', {
      icpDefinitionId: 'icp-1',
      criteria: { titles: ['Founder'], industry: ['tech'], geography: [] } as never,
      maxResults: 10,
    });

    // 2 candidates parsed per page (alice duplicate collapses in the parser),
    // 1 fresh after DB dedupe against existing bob.
    expect(report.discovered).toBe(2);
    expect(report.uniqueIngested).toBe(1);
    expect(report.duplicatesSkipped).toBe(1);
    expect(ingested).toHaveLength(1);
    expect(ingested[0]).toHaveLength(1);
    expect(ingested[0][0].name).toBe('Alice Founder');
    expect(ingested[0][0].linkedinUrl).toBe('https://www.linkedin.com/in/alice-founder');
    expect(report.qualified).toBe(1);
  });

  it('skips an existing campaign-ready prospect without sending it to ingestion', async () => {
    const { service, ingested } = buildService({
      existing: ['https://linkedin.com/in/alice-founder'],
    });

    const report = await service.discover('tenant-1', {
      icpDefinitionId: 'icp-1',
      criteria: { titles: ['Founder'], industry: ['tech'], geography: [] } as never,
    });

    expect(ingested).toHaveLength(1);
    expect(ingested[0]).toHaveLength(1);
    expect(ingested[0][0].linkedinUrl).toBe('https://www.linkedin.com/in/bob-director');
    expect(report.uniqueIngested).toBe(1);
    expect(report.duplicatesSkipped).toBe(1);
  });

  it('returns zero pipeline counts and skips ingestion without an ICP id', async () => {
    const { service, ingested } = buildService({});
    const report = await service.discover('tenant-1', {
      criteria: { titles: ['Founder'], industry: ['tech'], geography: [] } as never,
    });
    expect(report.discovered).toBe(2);
    expect(report.uniqueIngested).toBe(2);
    expect(ingested).toHaveLength(0);
    expect(report.qualified).toBe(0);
    expect(report.reviewRequired).toBe(0);
    expect(report.disqualified).toBe(0);
  });

  it('reports review-required and disqualified counts from persisted stages', async () => {
    const { service } = buildService({
      stages: { qualified: 0, reviewRequired: 1, disqualified: 1 },
    });
    const report = await service.discover('tenant-1', {
      icpDefinitionId: 'icp-1',
      criteria: { titles: ['Founder'], industry: ['tech'], geography: [] } as never,
    });
    expect(report.reviewRequired).toBe(1);
    expect(report.disqualified).toBe(1);
  });

  it('supports per-query HTML fixtures for multi-query runs', async () => {
    const seenQueries: string[] = [];
    const service = new ProspectDiscoveryService({
      searchHtml: async (query) => {
        seenQueries.push(query);
        return FIXTURE_HTML;
      },
      ingest: async () => {},
      countStages: async () => ({ qualified: 0, reviewRequired: 0, disqualified: 0 }),
    });
    const report = await service.discover('tenant-1', {
      icpDefinitionId: 'icp-1',
      criteria: { titles: ['Founder'], industry: ['tech'], geography: ['London', 'Berlin'] } as never,
    });
    expect(seenQueries).toHaveLength(2);
    expect(report.queries).toHaveLength(2);
    // 2 parsed per query x2 queries, deduped in-run to 2 unique.
    expect(report.discovered).toBe(4);
    expect(report.uniqueIngested).toBe(2);
    expect(report.duplicatesSkipped).toBe(2);
  });

  it('counts both multi-query duplicates and existing prospects as skipped', async () => {
    const { service, ingested } = buildService({
      existing: ['https://linkedin.com/in/bob-director'],
    });

    const report = await service.discover('tenant-1', {
      icpDefinitionId: 'icp-1',
      criteria: { titles: ['Founder'], industry: ['tech'], geography: ['London', 'Berlin'] } as never,
    });

    expect(report.discovered).toBe(4);
    expect(report.uniqueIngested).toBe(1);
    expect(report.duplicatesSkipped).toBe(3);
    expect(ingested).toHaveLength(1);
    expect(ingested[0]).toHaveLength(1);
    expect(ingested[0][0].linkedinUrl).toBe('https://www.linkedin.com/in/alice-founder');
  });
});
