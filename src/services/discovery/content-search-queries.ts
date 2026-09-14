/**
 * Channel 4 — LinkedIn content-search queries and URL builder.
 *
 * Presets follow a 75% BD / 25% candidate split (dual ICP): the majority of
 * queries target recruitment-agency leadership (buyers of BD/sourcing help),
 * the remainder target hiring leaders (buyers of candidate delivery).
 */

export type DatePostedWindow = 'past-24h' | 'past-week' | 'past-month';

/** Archetype A — agency leadership / BD pain points (75% of presets). */
export const BD_QUERY_PRESETS: readonly string[] = [
  'recruitment agency owner clients',
  'sourcing candidates manually',
  'recruitment BD pipeline',
  'agency founder hiring',
  'staffing agency growth',
  'tired of cold calling',
  'contingency vs retainer',
  'client ghosting agencies',
  'manual sourcing fatigue',
];

/** Archetype B — hiring leaders / candidate pain points (25% of presets). */
export const CANDIDATE_QUERY_PRESETS: readonly string[] = [
  'we are hiring recruiters',
  'struggling to fill role',
  'talent acquisition overload',
];

/**
 * Full preset list in the 75/25 BD-to-candidate ratio. Used when an operator
 * starts a content-search run without supplying custom queries.
 */
export function getContentSearchQueryPresets(): string[] {
  return [...BD_QUERY_PRESETS, ...CANDIDATE_QUERY_PRESETS];
}

/**
 * Builds the LinkedIn content-search results URL for a keyword query.
 *
 * Shape: /search/results/content/?keywords=<encoded>&datePosted=["past-24h"]&sortBy=["date_posted"]
 */
export function buildLinkedInContentSearchUrl(
  query: string,
  recency: DatePostedWindow = 'past-24h',
): string {
  const encoded = encodeURIComponent(query);
  const windowParam = encodeURIComponent(JSON.stringify([recency]));
  const sortBy = encodeURIComponent(JSON.stringify(['date_posted']));
  return `https://www.linkedin.com/search/results/content/?keywords=${encoded}&datePosted=${windowParam}&sortBy=${sortBy}`;
}