import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeCanonicalLinkedinUrl, type XrayCandidate } from './google-xray-source.js';

const execFileAsync = promisify(execFile);

const DEFAULT_LINKEDIN_KEYWORDS = '("Founder" OR "Managing Director") ("recruitment" OR "executive search")';
const DEFAULT_TITLE = 'Founder & Managing Director - Boutique Recruitment';
const DEFAULT_COMPANY = 'Boutique Recruitment Agency';
const DEFAULT_LOCATION = 'United States / Global';

export interface OpenCliRunOptions {
  timeoutMs: number;
}

export type OpenCliRunner = (args: string[], options: OpenCliRunOptions) => Promise<string>;

export class OpenCliUnavailableError extends Error {
  readonly code = 'OPENCLI_UNAVAILABLE';

  constructor(message = 'OpenCLI LinkedIn browser is unavailable') {
    super(message);
    this.name = 'OpenCliUnavailableError';
  }
}

export class OpenCliExecutionError extends Error {
  readonly code = 'OPENCLI_EXECUTION_FAILED';

  constructor(message = 'OpenCLI LinkedIn browser command failed') {
    super(message);
    this.name = 'OpenCliExecutionError';
  }
}

function defaultRunner(args: string[], options: OpenCliRunOptions): Promise<string> {
  return execFileAsync('opencli', args, {
    timeout: options.timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  }).then(({ stdout }) => stdout);
}

function cleanLine(value: string): string {
  return value.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
}

/** Converts Google X-Ray input into keywords accepted by LinkedIn people search. */
export function cleanLinkedinKeywords(rawQuery: string): string {
  if (!rawQuery || typeof rawQuery !== 'string') {
    return 'boutique recruitment founder';
  }
  let cleaned = rawQuery
    .replace(/site:linkedin\.com\/in\/?/gi, '')
    .replace(/-intitle:\S+/gi, '')
    .replace(/[()"']/g, ' ')
    .replace(/\b(OR|AND|NOT)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned || cleaned.length < 3) {
    return 'boutique recruitment founder';
  }
  return cleaned;
}

function companyAndTitle(headline: string): Pick<XrayCandidate, 'title' | 'company'> {
  const atMatch = headline.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
  if (atMatch) return { title: cleanLine(atMatch[1]), company: cleanLine(atMatch[2]) };
  return { title: cleanLine(headline), company: '' };
}

function looksLikeLocation(line: string): boolean {
  return /(?:,\s*[^,]+){1,}|\b(?:united kingdom|united states|canada|england|scotland|wales|ireland|australia)\b/i.test(line);
}

function isMutualConnectionLine(line: string): boolean {
  return /mutual connection|other connection|\/search\/results\/people\/\?origin=SHARED_CONNECTIONS/i.test(line);
}

function isCandidateProfileLink(match: RegExpMatchArray, line: string): boolean {
  return !isMutualConnectionLine(line) && !/^\s*!\[/.test(line) && match[1].trim().length > 0;
}

function cleanCandidateName(value: string): string {
  return cleanLine(value).replace(/\s*•\s*(?:1st|2nd|3rd)\b.*$/i, '').trim();
}

function isMetadataLine(line: string): boolean {
  return Boolean(line) && !isMutualConnectionLine(line) && !/^\*\s*\*\s*\*$/i.test(line)
    && !/^[-*]\s*$/.test(line) && !/!\[[^\]]*\]\(/.test(line) && !/\[[^\]]+\]\([^)]*\)/.test(line);
}

/** Parses the read-only markdown returned by `opencli browser linkedin extract`. */
export function parseOpenCliLinkedinMarkdown(markdown: string): XrayCandidate[] {
  const linkPattern = /\[([\s\S]*?)\]\((https?:\/\/[^\s)]*linkedin\.com\/in\/[^\s)]+)\)/gi;
  const searchableMarkdown = markdown
    .replace(
      /\[([\s\S]*?)\]\(/g,
      (_match: string, label: string) => `[${label.replace(/[\r\n]+/g, ' ')}](`,
    )
    .replace(
      /\[([^\]]*)\]\((?!https?:\/\/[^\s)]*linkedin\.com\/in\/)[^)]*\)/gi,
      '$1',
    );
  const links = [...searchableMarkdown.matchAll(linkPattern)];
  const candidateLinks = links.filter((match) => {
    const lineStart = searchableMarkdown.lastIndexOf('\n', match.index ?? 0) + 1;
    const lineEnd = searchableMarkdown.indexOf('\n', match.index ?? 0);
    return isCandidateProfileLink(match, searchableMarkdown.slice(lineStart, lineEnd < 0 ? searchableMarkdown.length : lineEnd));
  });
  const results: XrayCandidate[] = [];
  const seen = new Set<string>();
  
  for (let index = 0; index < candidateLinks.length; index += 1) {
    const match = candidateLinks[index];
    const rawName = match[1].replace(/[\r\n]+/g, ' ').trim();
    const name = cleanCandidateName(rawName);
    if (!name || name.length < 2) continue;

    let linkedinUrl: string;
    try {
      linkedinUrl = normalizeCanonicalLinkedinUrl(match[2]);
    } catch {
      continue;
    }
    const key = linkedinUrl.toLowerCase();
    if (seen.has(key)) continue;

    const blockEnd = candidateLinks[index + 1]?.index ?? searchableMarkdown.length;
    const lines = searchableMarkdown.slice((match.index ?? 0) + match[0].length, blockEnd)
      .split(/\r?\n/)
      .map(cleanLine)
      .filter(isMetadataLine);
    const textLines = lines.filter((line) => !line.startsWith('[')
      && !line.startsWith('!(')
      && !line.startsWith('http')
      && !line.startsWith('•')
      && !line.includes('linkedin.com')
      && line.trim().length > 3);
    const current = textLines.find((line) => /^current\s*:/i.test(line));
    const headline = textLines.find((line) => !/^current\s*:/i.test(line) && !looksLikeLocation(line)) ?? '';
    const currentMatch = current?.match(/^current\s*:\s*(.+?)\s+(?:at|@)\s+(.+)$/i);
    const fromHeadline = companyAndTitle(headline);
    const location = textLines.find(looksLikeLocation)
      ?? (textLines[1] && !/^current\s*:/i.test(textLines[1]) ? textLines[1] : '');

    results.push({
      name,
      title: (currentMatch ? cleanLine(currentMatch[1]) : fromHeadline.title) || DEFAULT_TITLE,
      company: (currentMatch ? cleanLine(currentMatch[2]) : fromHeadline.company) || DEFAULT_COMPANY,
      location: location || DEFAULT_LOCATION,
      linkedinUrl,
    });
    seen.add(key);
  }
  return results;
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

export class OpenCliLinkedinSource {
  private readonly runner: OpenCliRunner;
  private readonly timeoutMs: number;
  private readonly waitMs: number;

  constructor({ runner = defaultRunner, timeoutMs = 15_000, waitMs = 3_000 }: { runner?: OpenCliRunner; timeoutMs?: number; waitMs?: number } = {}) {
    this.runner = runner;
    this.timeoutMs = timeoutMs;
    this.waitMs = waitMs;
  }

  async search(query: string): Promise<XrayCandidate[]> {
    const cleanedQuery = cleanLinkedinKeywords(query);
    const url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(cleanedQuery)}`;
    let opened: string;
    try {
      opened = await this.runner(['browser', 'linkedin', 'open', url], { timeoutMs: this.timeoutMs });
    } catch (error) {
      const code = (error as { code?: string } | undefined)?.code;
      if (code === 'ENOENT') throw new OpenCliUnavailableError();
      throw new OpenCliExecutionError(error instanceof Error ? error.message : undefined);
    }
    const pageId = pageIdFromOpenOutput(opened);
    if (!pageId) throw new OpenCliExecutionError('OpenCLI did not return a LinkedIn page target');

    // Wait for the browser to render the search result cards.
    if (this.waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.waitMs));
    }

    let extractStdout: string;
    try {
      extractStdout = await this.runner(['browser', 'linkedin', 'extract', '--tab', pageId], { timeoutMs: this.timeoutMs });
    } catch (error) {
      throw new OpenCliExecutionError(error instanceof Error ? error.message : undefined);
    }
    let markdown = extractStdout;
    try {
      const json = JSON.parse(extractStdout) as { content?: unknown };
      if (json && typeof json.content === 'string') markdown = json.content;
    } catch {
      // Raw stdout fallback for older OpenCLI output.
    }
    return markdown.trim() ? parseOpenCliLinkedinMarkdown(markdown) : [];
  }
}
