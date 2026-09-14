import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalPostIdentifier } from '../engagement/post-identity.js';

const execFileAsync = promisify(execFile);

export type OpenCliRunner = (args: string[], options: { timeoutMs: number }) => Promise<string>;

function defaultRunner(args: string[], options: { timeoutMs: number }): Promise<string> {
  return execFileAsync('opencli', args, {
    timeout: options.timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  }).then(({ stdout }) => stdout);
}

function pageIdFromOpenOutput(output: string): string | null {
  if (!output.trim()) return null;
  try {
    const parsed = JSON.parse(output) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { page?: unknown }).page === 'string') {
      return (parsed as { page: string }).page;
    }
  } catch {
    // OpenCLI may include logging before JSON; its output remains invalid for a tab id.
  }
  return null;
}

function extractMarkdown(stdout: string): string {
  try {
    const json = JSON.parse(stdout) as { content?: unknown };
    if (json && typeof json.content === 'string') return json.content;
  } catch {
    // Raw stdout fallback for older OpenCLI output.
  }
  return stdout;
}

function cleanPostText(value: string): string {
  return value
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Typed records (pure, no DOM/browser state) ──────────────────────────────

export type PostRecency = 'past-24h' | 'past-week' | 'past-month';

export interface TargetPost {
  postUrl: string;
  authorName: string;
  postText: string;
}

export interface PostEngagerEntry {
  profileUrl: string;
  name: string;
  headline?: string;
  interaction: 'LIKE' | 'COMMENT';
  commentText?: string;
}

/** Pluggable seam for Channel 5's OpenCLI extraction (fixtures in tests). */
export interface PostEngagerRunner {
  fetchRecentPosts(targetUrl: string, recency?: PostRecency): Promise<TargetPost[]>;
  fetchEngagers(postUrl: string): Promise<PostEngagerEntry[]>;
}

// ─── Pure parsers ────────────────────────────────────────────────────────────

const POST_LINK_PATTERN = /\[([^\]]*)\]\((https?:\/\/[^\s)]*(?:\/feed\/update\/|urn:li:activity:|activity-|posts\/|pulse\/)[^\s)]*)\)/gi;
const PROFILE_LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^\s)]*\/in\/[^\s)]+)\)/;

/**
 * Transforms a root LinkedIn URL to its public activity feed subpath:
 * - Company pages: `${clean}/posts/?feedView=all`
 * - Personal profiles: `${clean}/recent-activity/all/`
 *
 * If the URL already targets an activity feed, it is preserved without duplication.
 */
export function toActivityFeedUrl(targetUrl: string): string {
  if (!targetUrl || typeof targetUrl !== 'string') return targetUrl;
  const clean = targetUrl.split(/[?#]/)[0].replace(/\/+$/, '');

  if (clean.includes('/recent-activity') || clean.endsWith('/posts')) {
    return targetUrl;
  }

  const companyMatch = clean.match(/^(https?:\/\/[^\/]+\/company\/[^\/]+)/i);
  if (companyMatch) {
    return `${companyMatch[1]}/posts/?feedView=all`;
  }

  const profileMatch = clean.match(/^(https?:\/\/[^\/]+\/in\/[^\/]+)/i);
  if (profileMatch) {
    return `${profileMatch[1]}/recent-activity/all/`;
  }

  return targetUrl;
}

/**
 * Parses relative time text into approximate elapsed hours.
 * Supports:
 * - Word forms: "2 days ago", "1 week ago", "3 hours ago", "1 month ago"
 * - Short forms: "1h", "4h", "2d", "5d", "1w", "3w", "1mo", "2mo", "1y"
 */
export function parseRelativeTimeHours(text: string): number | null {
  // Word patterns: "2 days ago", "1 month ago", "3 hours ago"
  const wordMatch = text.match(/\b(\d+)\s*(minute|hour|day|week|month|year)s?(?:\s*ago)?\b/i);
  if (wordMatch) {
    const val = parseInt(wordMatch[1], 10);
    const unit = wordMatch[2].toLowerCase();
    switch (unit) {
      case 'minute': return val / 60;
      case 'hour': return val;
      case 'day': return val * 24;
      case 'week': return val * 168;
      case 'month': return val * 720;
      case 'year': return val * 8760;
    }
  }

  // Short patterns: "1h", "4h", "2d", "5d", "1w", "3w", "1mo", "2mo"
  const shortMatch = text.match(/\b(\d+)\s*(mo|m|h|d|w|y)\b(?:\s*ago)?/i);
  if (shortMatch) {
    const val = parseInt(shortMatch[1], 10);
    const unit = shortMatch[2].toLowerCase();
    switch (unit) {
      case 'm': return val / 60;
      case 'h': return val;
      case 'd': return val * 24;
      case 'w': return val * 168;
      case 'mo': return val * 720;
      case 'y': return val * 8760;
    }
  }

  return null;
}

/**
 * Checks if the elapsed hours fall within the requested recency window:
 * - past-24h: <= 24 hours
 * - past-week: <= 168 hours (7 days, default)
 * - past-month: <= 720 hours (30 days)
 */
export function isWithinRecency(hours: number | null, recency: PostRecency = 'past-week'): boolean {
  if (hours === null) return true; // Retain post by default if no timestamp is detected
  switch (recency) {
    case 'past-24h':
      return hours <= 24;
    case 'past-week':
      return hours <= 168;
    case 'past-month':
      return hours <= 720;
    default:
      return true;
  }
}

/**
 * Best-effort parser for the read-only markdown returned by
 * `opencli browser linkedin extract` on a target profile/company/page that
 * shows recent activity. Post cards are identified by their canonical post
 * links. Relative timestamps (e.g. "1h", "4h", "2d", "5d", "1w", "3w", "1mo", "2mo")
 * are parsed and filtered against the chosen recency window (defaulting to 'past-week').
 * The author is unknown from the feed alone, so it is left empty and the
 * caller substitutes the target's display name. Unparseable output yields no
 * posts — it is never silently fabricated.
 */
export function parseTargetProfileMarkdown(markdown: string, recency: PostRecency = 'past-week'): TargetPost[] {
  if (!markdown || !markdown.trim()) return [];

  const posts: TargetPost[] = [];
  const seen = new Set<string>();

  const matches = [...markdown.matchAll(POST_LINK_PATTERN)];
  for (const match of matches) {
    const postUrl = match[2].trim();
    const key = canonicalPostIdentifier(postUrl);
    if (seen.has(key)) continue;
    seen.add(key);

    const matchIdx = match.index ?? 0;
    const blockStart = markdown.lastIndexOf('\n', matchIdx) + 1;
    const blockEnd = markdown.indexOf('\n\n', matchIdx);
    const block = markdown.slice(blockStart, blockEnd < 0 ? markdown.length : blockEnd);
    const postText = cleanPostText(block.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
    if (!postText || postText.length < 20) continue;

    // Search for relative post timestamp in the context around the post link
    const contextStart = markdown.lastIndexOf('\n', Math.max(0, blockStart - 2)) + 1;
    const contextEnd = blockEnd < 0 ? markdown.length : Math.min(markdown.length, blockEnd + 100);
    const contextLines = markdown.slice(contextStart, contextEnd).split(/\r?\n/);

    let hours: number | null = null;
    for (const line of contextLines) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && trimmed.length < 40) {
        const parsed = parseRelativeTimeHours(trimmed);
        if (parsed !== null) {
          hours = parsed;
          break;
        }
      }
    }
    if (hours === null) {
      hours = parseRelativeTimeHours(block);
    }

    if (!isWithinRecency(hours, recency)) {
      continue;
    }

    posts.push({ postUrl, authorName: '', postText });
  }

  return posts;
}

/**
 * Best-effort parser for the read-only markdown of an extracted LinkedIn post
 * page. Engagers are grouped under "Liked by"/reactions or "Comments" headings;
 * each `[Name](https://www.linkedin.com/in/...)` link inside a section becomes a
 * typed entry with the visible headline and, for comments, the comment text.
 *
 * Deterministic rules:
 * - The nearest preceding `## Liked by` / `## Comments` heading sets the
 *   interaction. Entries outside any known section are skipped (no fabrication).
 * - The next non-empty line after the profile link is the visible headline; for
 *   comments the following non-empty line (same paragraph) is the comment text.
 * - Entries are deduped by profile URL (first occurrence wins).
 */
export function parsePostEngagersMarkdown(markdown: string): PostEngagerEntry[] {
  if (!markdown || !markdown.trim()) return [];

  const lines = markdown.split(/\r?\n/);
  const entries: PostEngagerEntry[] = [];
  const seen = new Set<string>();
  let section: 'LIKE' | 'COMMENT' | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(/^#{1,6}\s*(liked by|reactions|comments)/i);
    if (heading) {
      const label = heading[1].toLowerCase();
      section = label.startsWith('like') || label.startsWith('react') ? 'LIKE' : 'COMMENT';
      continue;
    }

    const link = line.match(PROFILE_LINK_PATTERN);
    if (!link || !section) continue;
    const name = link[1].trim();
    if (!name) continue;
    const profileUrl = link[2].trim();
    if (seen.has(profileUrl)) continue;
    seen.add(profileUrl);

    // Entry body: following non-empty lines until blank, heading, or next profile link.
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next) break;
      if (/^#{1,6}\s/i.test(next)) break;
      if (PROFILE_LINK_PATTERN.test(next)) break;
      body.push(next);
    }

    const entry: PostEngagerEntry = {
      profileUrl,
      name,
      interaction: section,
    };
    if (body.length > 0) entry.headline = body[0];
    if (section === 'COMMENT' && body.length > 1) {
      entry.commentText = body.slice(1).join(' ');
    }
    entries.push(entry);
  }

  return entries;
}

/**
 * Production Channel 5 runner: drives a LinkedIn target page (for recent posts)
 * or a post page (for engagers) through OpenCLI (`browser linkedin open` +
 * `extract`) and parses the returned markdown into typed records. Never spawns
 * processes or touches the DOM directly — the injected runner is swappable.
 */
export class OpenCliPostEngagerRunner implements PostEngagerRunner {
  private readonly runner: OpenCliRunner;
  private readonly timeoutMs: number;
  private readonly waitMs: number;

  constructor({ runner = defaultRunner, timeoutMs = 15_000, waitMs = 3_000 }: { runner?: OpenCliRunner; timeoutMs?: number; waitMs?: number } = {}) {
    this.runner = runner;
    this.timeoutMs = timeoutMs;
    this.waitMs = waitMs;
  }

  private async openAndExtract(url: string): Promise<string> {
    const opened = await this.runner(['browser', 'linkedin', 'open', url], { timeoutMs: this.timeoutMs });
    const pageId = pageIdFromOpenOutput(opened);
    if (!pageId) throw new Error('OPENCLI_NO_PAGE_TARGET');

    if (this.waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.waitMs));
    }

    const extractStdout = await this.runner(['browser', 'linkedin', 'extract', '--tab', pageId], { timeoutMs: this.timeoutMs });
    return extractMarkdown(extractStdout);
  }

  async fetchRecentPosts(targetUrl: string, recency?: PostRecency): Promise<TargetPost[]> {
    const feedUrl = toActivityFeedUrl(targetUrl);
    const markdown = await this.openAndExtract(feedUrl);
    return markdown.trim() ? parseTargetProfileMarkdown(markdown, recency) : [];
  }

  async fetchEngagers(postUrl: string): Promise<PostEngagerEntry[]> {
    const markdown = await this.openAndExtract(postUrl);
    return markdown.trim() ? parsePostEngagersMarkdown(markdown) : [];
  }
}