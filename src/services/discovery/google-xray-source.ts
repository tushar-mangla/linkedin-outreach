import { normalizeLinkedinUrl } from '../icp/url-normalizer.js';

export interface XrayCandidate {
  name: string;
  title: string;
  company: string;
  location: string;
  linkedinUrl: string;
}

export type XrayFetchResult = { status: number; body: string; retryAfter?: string | number; retryAfterMs?: number };

export type XrayFetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<XrayFetchResult>;

export class XrayRateLimitedError extends Error {
  readonly code = 'SEARCH_RATE_LIMITED';
  readonly retryAfterMs?: number;
  constructor(message = 'Search provider rate limit reached', retryAfterMs?: number) {
    super(message);
    this.name = 'XrayRateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class XrayBlockedError extends Error {
  readonly code = 'SEARCH_BLOCKED';
  constructor(message = 'Search provider blocked the request') {
    super(message);
    this.name = 'XrayBlockedError';
  }
}

export class XrayNetworkError extends Error {
  readonly code = 'SEARCH_PROVIDER_UNAVAILABLE';
  constructor(message = 'Search provider request failed') {
    super(message);
    this.name = 'XrayNetworkError';
  }
}

const STABLE_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) RecruitmentOS-Discovery/0.7 Safari/537.36';

function defaultFetcher(url: string, init?: { signal?: AbortSignal }): Promise<XrayFetchResult> {
  const fetchFn = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
  if (typeof fetchFn !== 'function') {
    return Promise.reject(new XrayNetworkError('No fetch implementation available'));
  }
  return fetchFn(url, {
    signal: init?.signal,
    headers: { 'User-Agent': STABLE_USER_AGENT, Accept: 'text/html' },
  }).then(
    async (res) => ({ status: res.status, body: await res.text(), retryAfter: res.headers.get('retry-after') ?? undefined }),
    (err) => {
      throw new XrayNetworkError(err instanceof Error ? err.message : 'Search request failed');
    },
  );
}

/** Canonical public profile URL: https://www.linkedin.com/in/<handle> (no tracking params). */
export function normalizeCanonicalLinkedinUrl(rawUrl: string): string {
  let decoded = rawUrl.trim();
  // Unwrap common redirect wrappers (/url?q=<target>).
  try {
    const parsed = new URL(decoded, 'https://www.google.com');
    const wrapped = parsed.searchParams.get('q') ?? parsed.searchParams.get('url') ?? parsed.searchParams.get('uddg');
    if (wrapped && wrapped.includes('linkedin.com/in/')) decoded = wrapped;
  } catch {
    // Fall through to the strict normalizer below.
  }
  const normalized = normalizeLinkedinUrl(decoded);
  const match = normalized.match(/^https:\/\/linkedin\.com\/in\/([^/]+)$/);
  if (!match) throw new Error('URL must be a LinkedIn profile URL');
  return `https://www.linkedin.com/in/${match[1]}`;
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNameHeadline(anchorText: string): { name: string; title: string; company: string } {
  const cleaned = anchorText.replace(/\s*\|\s*LinkedIn\s*$/i, '').trim();
  const [head, ...rest] = cleaned.split(/\s+-\s+|\s+–\s+|\s+—\s+/);
  const name = (head ?? '').trim();
  const headline = rest.join(' - ').trim();
  if (!headline) return { name, title: '', company: '' };
  // Common shapes: "Founder at Acme Search", "Founder @ Acme", "Founder, Acme Search".
  const atSplit = headline.split(/\s+at\s+|\s+@\s+/i);
  if (atSplit.length >= 2) {
    return { name, title: atSplit[0].trim(), company: atSplit.slice(1).join(' at ').trim() };
  }
  const commaSplit = headline.split(/\s*,\s*/);
  if (commaSplit.length >= 2) {
    return { name, title: commaSplit[0].trim(), company: commaSplit.slice(1).join(', ').trim() };
  }
  return { name, title: headline, company: '' };
}

function extractLocation(snippet: string, locationDefault?: string): string {
  const match = snippet.match(/\b(?:based|located|working)\s+(?:in|from)\s+([^.!?]+)/i);
  return match?.[1]?.trim() || locationDefault || '';
}

/**
 * Parses public search-result HTML (Google or DuckDuckGo shape) into LinkedIn
 * profile candidates. Only `linkedin.com/in/` URLs are accepted; everything
 * else (company pages, jobs, schools) is skipped. Missing fields stay empty —
 * they are evidence gaps, never invented facts.
 */
export function parseXrayHtml(html: string, opts: { locationDefault?: string } = {}): XrayCandidate[] {
  const candidates: XrayCandidate[] = [];
  const seen = new Set<string>();
  const anchorPattern = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null) {
    const href = match[1];
    if (!href) continue;
    let candidateHref = href;
    try {
      const parsedHref = new URL(href, 'https://html.duckduckgo.com');
      candidateHref = parsedHref.searchParams.get('q') ?? parsedHref.searchParams.get('url') ?? parsedHref.searchParams.get('uddg') ?? href;
    } catch {
      // Let canonical normalization reject malformed links below.
    }
    if (!/linkedin\.com\/in\//i.test(candidateHref)) continue;
    let canonical: string;
    try {
      canonical = normalizeCanonicalLinkedinUrl(candidateHref);
    } catch {
      continue;
    }
    const key = canonical.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const anchorText = stripTags(match[2] ?? '');
    // Snippet: plain text following the anchor (bounded window, tags stripped).
    const after = html.slice(match.index + match[0].length, match.index + match[0].length + 1200);
    const snippet = stripTags(after).slice(0, 400);
    const { name, title, company } = parseNameHeadline(anchorText || snippet);
    if (!name) continue;
    candidates.push({
      name,
      title,
      company,
      location: extractLocation(snippet, opts.locationDefault),
      linkedinUrl: canonical,
    });
  }
  return candidates;
}

export interface XraySearchOptions {
  maxResults?: number;
  timeoutMs?: number;
  fetcher?: XrayFetcher;
}

function parseRetryAfter(retryAfter: string | number | undefined, retryAfterMs?: number): number | undefined {
  if (retryAfterMs !== undefined) return retryAfterMs;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) return Math.max(0, retryAfter * 1000);
  if (typeof retryAfter !== 'string') return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(retryAfter);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now());
}

function classifyStatus(status: number, body: string, retryAfter?: string | number, retryAfterMs?: number): void {
  const retryAfterDelayMs = parseRetryAfter(retryAfter, retryAfterMs);
  if (status === 429) throw new XrayRateLimitedError('Search provider rate limit reached', retryAfterDelayMs);
  if (status === 403 || status === 503 || /captcha|challenge|unusual traffic|dissolve/i.test(body.slice(0, 4000))) {
    throw new XrayBlockedError(`Search provider blocked the request (status ${status})`);
  }
  if (status < 200 || status >= 300) {
    throw new XrayNetworkError(`Search provider responded with status ${status}`);
  }
}

function duckDuckGoUrl(query: string): string {
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
}

/** Searches Google first and falls back to DuckDuckGo HTML when Google blocks automation. */
export class GoogleXraySource {
  private readonly fetcher: XrayFetcher;

  constructor(fetcher?: XrayFetcher) {
    this.fetcher = fetcher ?? defaultFetcher;
  }

  async searchHtml(query: string, opts: XraySearchOptions = {}): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? 10000;
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${opts.maxResults ?? 10}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetcher(googleUrl, { signal: controller.signal });
      try {
        classifyStatus(res.status, res.body, res.retryAfter, res.retryAfterMs);
        return res.body;
      } catch (err) {
        if (!(err instanceof XrayRateLimitedError || err instanceof XrayBlockedError)) throw err;
        const fallback = await this.fetcher(duckDuckGoUrl(query), { signal: controller.signal });
        classifyStatus(fallback.status, fallback.body, fallback.retryAfter, fallback.retryAfterMs);
        return fallback.body;
      }
    } catch (err) {
      if (err instanceof XrayRateLimitedError || err instanceof XrayBlockedError || err instanceof XrayNetworkError) {
        throw err;
      }
      throw new XrayNetworkError(err instanceof Error ? err.message : 'Search request failed');
    } finally {
      clearTimeout(timer);
    }
  }

  async search(query: string, opts: XraySearchOptions & { locationDefault?: string } = {}): Promise<XrayCandidate[]> {
    const html = await this.searchHtml(query, opts);
    return parseXrayHtml(html, { locationDefault: opts.locationDefault }).slice(0, opts.maxResults ?? 10);
  }
}
