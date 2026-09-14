import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProspectPostSource, RawPost } from './prospect-post-source.js';
import type { PostSourceType } from '../../types.js';

const execFileAsync = promisify(execFile);

// ─── ProfileActivityPostSource ────────────────────────────────────────────────
//
// Supervised post discovery using OpenCLI.
// Uses the operator's existing authenticated Chrome browser session via OpenCLI.
//

export class ProfileActivityPostSource implements ProspectPostSource {
  readonly sourceType: PostSourceType = 'PLAYWRIGHT';

  async findRecentPosts(
    _prospectId: string,
    _tenantId: string,
    profileUrl: string,
  ): Promise<RawPost[]> {
    // Strictly use OpenCLI (uses the user's existing, authenticated Chrome session)
    try {
      const opencliPosts = await this.findPostsViaOpenCli(profileUrl);
      if (opencliPosts.length > 0) {
        console.log(`[ProfileActivityPostSource] OpenCLI fetched ${opencliPosts.length} posts for ${profileUrl}`);
        return opencliPosts;
      }
    } catch (err) {
      console.warn(`[ProfileActivityPostSource] OpenCLI post fetch failed (${(err as Error).message})`);
    }

    return [];
  }

  private async findPostsViaOpenCli(profileUrl: string): Promise<RawPost[]> {
    const { stdout } = await execFileAsync('opencli', [
      'linkedin', 'posts',
      '--profile-url', profileUrl,
      '--limit', '5',
      '-f', 'json'
    ], { timeout: 25_000, maxBuffer: 5 * 1024 * 1024 });

    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];

    const posts: RawPost[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i];
      const bodyText = typeof item.body === 'string' && item.body.trim()
        ? item.body.trim()
        : typeof item.raw_text === 'string'
        ? item.raw_text.trim()
        : '';
      if (!bodyText || bodyText.length < 20) continue;

      const rawUrl = typeof item.url === 'string' && item.url.startsWith('http')
        ? item.url
        : null;

      if (!rawUrl) {
        // Discard items without a verifiable real post URL (no synthetic #post-N)
        continue;
      }

      const authorName = typeof item.author === 'string' && item.author.trim()
        ? item.author.trim()
        : 'Unknown';

      posts.push({
        postUrl: rawUrl,
        postText: bodyText,
        authorName,
      });
    }
    return posts;
  }
}

