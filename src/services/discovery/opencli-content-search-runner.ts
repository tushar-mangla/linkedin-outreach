import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalPostIdentifier } from '../engagement/post-identity.js';
import { buildLinkedInContentSearchUrl, type DatePostedWindow } from './content-search-queries.js';
import type { ContentSearchPost, ContentSearchRunner } from './content-search-channel.js';

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

function cleanPostText(value: string): string {
  return value
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Best-effort parser for the read-only markdown returned by
 * `opencli browser linkedin extract` on a content-search results page.
 * Post cards are identified by their canonical post links; the author is the
 * nearest preceding /in/ profile link. Unparseable output yields no posts —
 * it is never silently fabricated.
 */
export function parseContentSearchMarkdown(markdown: string): ContentSearchPost[] {
  if (!markdown || !markdown.trim()) return [];

  const posts: ContentSearchPost[] = [];
  const seen = new Set<string>();

  const postLinkPattern = /\[([^\]]*)\]\((https?:\/\/[^\s)]*(?:\/feed\/update\/|urn:li:activity:|activity-|posts\/|pulse\/)[^\s)]*)\)/gi;
  const matches = [...markdown.matchAll(postLinkPattern)];

  for (const match of matches) {
    const postUrl = match[2].trim();
    const key = canonicalPostIdentifier(postUrl);
    if (seen.has(key)) continue;
    seen.add(key);

    // Surrounding block (up to the next blank line) is the post body.
    const blockStart = markdown.lastIndexOf('\n', match.index ?? 0) + 1;
    const blockEnd = markdown.indexOf('\n\n', match.index ?? 0);
    const block = markdown.slice(blockStart, blockEnd < 0 ? markdown.length : blockEnd);
    const postText = cleanPostText(block.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
    if (!postText || postText.length < 20) continue;

    // Author: nearest preceding /in/ profile link.
    const before = markdown.slice(0, match.index ?? 0);
    const authorLinks = [...before.matchAll(/\[([^\]]*)\]\((https?:\/\/[^\s)]*\/in\/[^\s)]+)\)/gi)];
    const authorLink = authorLinks[authorLinks.length - 1];
    const authorName = authorLink?.[1]?.trim() ?? '';
    const authorProfileUrl = authorLink?.[2]?.trim() ?? '';
    if (!authorProfileUrl) continue;

    posts.push({ postUrl, postText, authorName, authorProfileUrl });
  }

  return posts;
}

/**
 * Production content-search runner: drives the LinkedIn content-search URL
 * through OpenCLI (`browser linkedin open` + `extract`) and parses the
 * returned markdown into posts.
 */
export class OpenCliContentSearchRunner implements ContentSearchRunner {
  private readonly runner: OpenCliRunner;
  private readonly timeoutMs: number;
  private readonly waitMs: number;

  constructor({ runner = defaultRunner, timeoutMs = 15_000, waitMs = 3_000 }: { runner?: OpenCliRunner; timeoutMs?: number; waitMs?: number } = {}) {
    this.runner = runner;
    this.timeoutMs = timeoutMs;
    this.waitMs = waitMs;
  }

  async search(query: string, recency: DatePostedWindow): Promise<ContentSearchPost[]> {
    const url = buildLinkedInContentSearchUrl(query, recency);
    const opened = await this.runner(['browser', 'linkedin', 'open', url], { timeoutMs: this.timeoutMs });
    const pageId = pageIdFromOpenOutput(opened);
    if (!pageId) throw new Error('OPENCLI_NO_PAGE_TARGET');

    if (this.waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.waitMs));
    }

    const extractStdout = await this.runner(['browser', 'linkedin', 'extract', '--tab', pageId], { timeoutMs: this.timeoutMs });
    let markdown = extractStdout;
    try {
      const json = JSON.parse(extractStdout) as { content?: unknown };
      if (json && typeof json.content === 'string') markdown = json.content;
    } catch {
      // Raw stdout fallback for older OpenCLI output.
    }
    return markdown.trim() ? parseContentSearchMarkdown(markdown) : [];
  }
}