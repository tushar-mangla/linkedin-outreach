import type { IcpCriteria } from '../../schemas/icp.js';

export const DEFAULT_XRAY_TITLES = [
  'Founder',
  'Managing Director',
  'Managing Partner',
  'Commercial Director',
];

export const DEFAULT_XRAY_AGENCY_TERMS = ['recruitment', 'executive search', 'staffing'];

export const DEFAULT_XRAY_NICHES = ['tech', 'engineering', 'finance', 'life sciences'];

export const DEFAULT_XRAY_NEGATIVES = ['-intitle:jobs'];

export const XRAY_MAX_QUERIES = 3;
export const XRAY_MAX_QUERY_LENGTH = 500;

export interface XrayQueryInput {
  titles?: string[];
  industries?: string[];
  /** Alias for industries (niche terms such as tech, engineering). */
  niches?: string[];
  locations?: string[];
  /** Agency-domain terms; defaults to recruitment / executive search / staffing. */
  agencyTerms?: string[];
  /** Extra negative terms, e.g. "-intitle:jobs". Defaults applied when omitted. */
  negativeTerms?: string[];
  maxQueries?: number;
}

function cleanTerms(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    // Query terms are data, not query syntax. Remove quote/parens and boolean
    // operators before quoting each term in a clause.
    const term = raw
      .trim()
      .replace(/["'()]/g, ' ')
      .replace(/\b(?:AND|OR|NOT)\b/gi, ' ')
      .replace(/\b(?:site|intitle)\s*:\s*\S+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

function appendTerms(query: string, terms: string[], maxLength: number, alwaysWrap = false): string {
  let clause = '';
  for (const term of terms) {
    const nextClause = clause ? `${clause} OR "${term}"` : `"${term}"`;
    const wrapped = clause || (terms.length === 1 && !alwaysWrap) ? nextClause : `(${nextClause})`;
    if (`${query} ${wrapped}`.length > maxLength) break;
    clause = nextClause;
  }
  if (!clause) return '';
  return clause.includes(' OR ') || alwaysWrap ? `(${clause})` : clause;
}

function cleanNegativeTerms(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const cleaned = raw
      .trim()
      .replace(/["'()]/g, ' ')
      .replace(/\b(?:AND|OR|NOT)\b/gi, ' ')
      .replace(/\bsite\s*:\s*\S+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) continue;
    const intitle = cleaned.match(/^-?intitle:([\w-]+)$/i);
    const value = intitle ? `-intitle:${intitle[1]}` : `-"${cleaned.replace(/^-+/, '')}"`;
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(value);
    }
  }
  return out;
}

/**
 * Builds deterministic Google X-Ray query strings for LinkedIn profile discovery.
 *
 * Shape: `site:linkedin.com/in/ ("Title" OR ...) ("agency" OR ...) ("niche" OR ...)
 * ("Location" OR ...) -intitle:jobs`
 *
 * Locations produce one query variant per location (capped by maxQueries) so a
 * single run cannot fan out into an unbounded cartesian expansion.
 */
export function buildXrayQueries(input: XrayQueryInput = {}): string[] {
  const titles = cleanTerms(input.titles).length > 0 ? cleanTerms(input.titles) : [...DEFAULT_XRAY_TITLES];
  const agencyTerms =
    input.agencyTerms !== undefined ? cleanTerms(input.agencyTerms) : [...DEFAULT_XRAY_AGENCY_TERMS];
  const nicheInput = cleanTerms(input.niches).length > 0 ? cleanTerms(input.niches) : cleanTerms(input.industries);
  const niches = nicheInput.length > 0 ? nicheInput : [...DEFAULT_XRAY_NICHES];
  const locations = cleanTerms(input.locations);
  const negatives = input.negativeTerms !== undefined ? cleanNegativeTerms(input.negativeTerms) : [...DEFAULT_XRAY_NEGATIVES];
  const maxQueries =
    Number.isInteger(input.maxQueries) && (input.maxQueries as number) > 0
      ? Math.min(input.maxQueries as number, XRAY_MAX_QUERIES)
      : XRAY_MAX_QUERIES;

  const variants = locations.length > 0 ? locations.slice(0, maxQueries) : [undefined];
  return variants.map((location) => {
    let query = 'site:linkedin.com/in/';
    for (const [group, alwaysWrap] of [[titles, false], [agencyTerms, false], [niches, false], [location ? [location] : [], true]] as const) {
      const clause = appendTerms(query, group, XRAY_MAX_QUERY_LENGTH, alwaysWrap);
      if (clause) query += ` ${clause}`;
    }
    for (const negative of negatives) {
      if (`${query} ${negative}`.length > XRAY_MAX_QUERY_LENGTH) break;
      query += ` ${negative}`;
    }
    return query;
  });
}

/** Convenience wrapper that derives X-Ray queries from a saved ICP definition. */
export function buildXrayQueriesFromCriteria(
  criteria: Partial<IcpCriteria>,
  overrides: Omit<XrayQueryInput, 'titles' | 'industries' | 'niches'> = {},
): string[] {
  return buildXrayQueries({
    titles: Array.isArray(criteria.titles) ? criteria.titles : [],
    industries: Array.isArray(criteria.industry) ? criteria.industry : [],
    locations: Array.isArray(criteria.geography) ? criteria.geography : [],
    negativeTerms: Array.isArray(criteria.hardExclusions)
      ? criteria.hardExclusions.map(String)
      : undefined,
    ...overrides,
    // Explicit override locations win over saved geography when provided.
    ...(overrides.locations !== undefined ? { locations: overrides.locations } : {}),
  });
}
