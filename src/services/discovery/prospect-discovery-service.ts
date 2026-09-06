import type { IcpCriteria, ProspectInput } from '../../schemas/icp.js';
import { normalizeLinkedinUrl } from '../icp/url-normalizer.js';
import { buildXrayQueries, buildXrayQueriesFromCriteria } from './xray-query-builder.js';
import { GoogleXraySource, parseXrayHtml, type XrayCandidate } from './google-xray-source.js';

export interface DiscoveryReport {
  discovered: number;
  uniqueIngested: number;
  duplicatesSkipped: number;
  qualified: number;
  reviewRequired: number;
  disqualified: number;
  queries?: string[];
}

export interface DiscoveryRunOptions {
  icpDefinitionId?: string;
  criteria?: Partial<IcpCriteria>;
  locations?: string[];
  maxResults?: number;
  locationDefault?: string;
  /** Offline/test seam: raw search HTML per query (bypasses network). */
  searchHtml?: string | string[];
}

export interface DiscoveryServiceDeps {
  /** Primary source seam for structured candidates (used by OpenCLI LinkedIn). */
  searchCandidates?: (query: string) => Promise<XrayCandidate[]>;
  searchHtml?: (query: string) => Promise<string>;
  findExisting?: (tenantId: string, normalizedUrls: string[]) => Promise<Set<string>>;
  ingest?: (tenantId: string, icpDefinitionId: string, rows: ProspectInput[]) => Promise<void>;
  countStages?: (
    tenantId: string,
    normalizedUrls: string[],
  ) => Promise<{ qualified: number; reviewRequired: number; disqualified: number }>;
  loadCriteria?: (tenantId: string, icpDefinitionId: string) => Promise<IcpCriteria | null>;
}

function toProspectRow(candidate: XrayCandidate): ProspectInput {
  return {
    name: candidate.name,
    title: candidate.title,
    company: candidate.company,
    location: candidate.location,
    linkedinUrl: candidate.linkedinUrl,
    rawData: {
      source: 'GOOGLE_XRAY',
      title: candidate.title,
      company: candidate.company,
      location: candidate.location,
    },
  };
}

/** Canonical dedupe key shared with the prospects unique constraint. */
export function discoveryDedupeKey(linkedinUrl: string): string | null {
  try {
    return normalizeLinkedinUrl(linkedinUrl).toLowerCase();
  } catch {
    return null;
  }
}

export class ProspectDiscoveryService {
  private readonly deps: DiscoveryServiceDeps;
  private readonly source: GoogleXraySource | null;

  constructor(deps: DiscoveryServiceDeps = {}, source?: GoogleXraySource) {
    this.deps = deps;
    this.source = source ?? null;
  }

  private async candidatesForQuery(query: string, fallback: string | string[] | undefined, index: number, locationDefault: string): Promise<XrayCandidate[]> {
    if (this.deps.searchCandidates) return this.deps.searchCandidates(query);
    if (fallback !== undefined) {
      const html = Array.isArray(fallback) ? (fallback[index] ?? fallback[0] ?? '') : fallback;
      return parseXrayHtml(html, { locationDefault });
    }
    if (this.deps.searchHtml) return parseXrayHtml(await this.deps.searchHtml(query), { locationDefault });
    const source = this.source ?? new GoogleXraySource();
    return source.search(query, { locationDefault });
  }

  async discover(tenantId: string, options: DiscoveryRunOptions = {}): Promise<DiscoveryReport> {
    let criteria = options.criteria;
    if (!criteria && options.icpDefinitionId && this.deps.loadCriteria) {
      const loaded = await this.deps.loadCriteria(tenantId, options.icpDefinitionId);
      if (loaded) criteria = loaded;
    }

    const queries =
      criteria && Object.keys(criteria).length > 0
        ? buildXrayQueriesFromCriteria(criteria as IcpCriteria, {
            ...(options.locations !== undefined ? { locations: options.locations } : {}),
          })
        : buildXrayQueries({
            ...(options.locations !== undefined ? { locations: options.locations } : {}),
          });

    const maxResults = Math.min(Math.max(options.maxResults ?? 10, 1), 25);
    const locationDefault = options.locationDefault ?? options.locations?.[0] ?? '';

    // 1. Search + parse every query variant.
    const allParsed: XrayCandidate[] = [];
    for (let i = 0; i < queries.length; i += 1) {
      const candidates = await this.candidatesForQuery(queries[i], options.searchHtml, i, locationDefault);
      allParsed.push(...candidates.slice(0, maxResults));
    }
    const discovered = allParsed.length;

    // 2. In-run dedupe by canonical LinkedIn URL.
    const uniqueByKey = new Map<string, XrayCandidate>();
    for (const candidate of allParsed) {
      const key = discoveryDedupeKey(candidate.linkedinUrl);
      if (!key) continue;
      if (!uniqueByKey.has(key)) uniqueByKey.set(key, candidate);
    }

    // 3. Dedupe against existing tenant prospects.
    let fresh = [...uniqueByKey.entries()];
    if (this.deps.findExisting && fresh.length > 0) {
      const existing = await this.deps.findExisting(
        tenantId,
        fresh.map(([key]) => key),
      );
      fresh = fresh.filter(([key]) => !existing.has(key));
    }
    const rows = fresh.map(([, candidate]) => toProspectRow(candidate));
    const uniqueIngested = rows.length;
    const duplicatesSkipped = allParsed.length - fresh.length;

    if (rows.length === 0 || !options.icpDefinitionId) {
      return { discovered, uniqueIngested, duplicatesSkipped, qualified: 0, reviewRequired: 0, disqualified: 0, queries };
    }

    // 4. Ingest through the ICP pipeline (deterministic filter first, then AI scoring).
    if (this.deps.ingest) {
      await this.deps.ingest(tenantId, options.icpDefinitionId, rows);
    }

    // 5. Classify ingested prospects from their persisted stages.
    let qualified = 0;
    let reviewRequired = 0;
    let disqualified = 0;
    if (this.deps.countStages) {
      const counts = await this.deps.countStages(
        tenantId,
        rows.map((r) => discoveryDedupeKey(r.linkedinUrl)).filter((k): k is string => k !== null),
      );
      qualified = counts.qualified;
      reviewRequired = counts.reviewRequired;
      disqualified = counts.disqualified;
    }

    return { discovered, uniqueIngested, duplicatesSkipped, qualified, reviewRequired, disqualified, queries };
  }
}
