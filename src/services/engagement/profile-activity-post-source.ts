import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProspectPostSource, RawPost } from './prospect-post-source.js';
import type { PostSourceType } from '../../types.js';

const execFileAsync = promisify(execFile);

// ─── ProfileActivityPostSource ────────────────────────────────────────────────
//
// Supervised post discovery using OpenCLI / Playwright.
// Visits the prospect's profile activity page and extracts recent posts.
//

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE_DIR = process.env.LINKEDIN_PROFILE_DIR ?? `${process.env.HOME}/.opencli/clis/chrome-profile`;
const POST_SELECTOR = '.profile-creator-shared-feed-update__container, .feed-shared-update-v2, [data-urn*="activity"]';
const POST_TEXT_SELECTOR = '.feed-shared-text span[dir="ltr"], .update-components-text span[dir="ltr"], .break-words span[dir="ltr"], .break-words';
const POST_DATE_SELECTOR = 'a.app-aware-link time, .update-components-actor__sub-description time, .update-components-actor__sub-description .visually-hidden';
const MAX_POSTS = 5;
const PAGE_TIMEOUT = 20_000;

export class ProfileActivityPostSource implements ProspectPostSource {
  readonly sourceType: PostSourceType = 'PLAYWRIGHT';

  async findRecentPosts(
    _prospectId: string,
    _tenantId: string,
    profileUrl: string,
  ): Promise<RawPost[]> {
    // 1. Try OpenCLI posts command first (uses existing opencli Chrome profile)
    try {
      const opencliPosts = await this.findPostsViaOpenCli(profileUrl);
      if (opencliPosts.length > 0) {
        console.log(`[ProfileActivityPostSource] OpenCLI fetched ${opencliPosts.length} posts for ${profileUrl}`);
        return opencliPosts;
      }
    } catch (err) {
      console.warn(`[ProfileActivityPostSource] OpenCLI post fetch failed (${(err as Error).message}), falling back to Playwright`);
    }

    // 2. Fall back to Playwright
    const activityUrl = this.buildActivityUrl(profileUrl);

    // Launch headed persistent context (always headed for supervised scanning)
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      executablePath: this.chromePath(),
      viewport: { width: 1440, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });

    const page = await ctx.newPage();
    const posts: RawPost[] = [];

    try {
      await page.goto(activityUrl, { timeout: PAGE_TIMEOUT, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000); // Allow feed to load

      // Check if we are redirected to login page
      if (page.url().includes('/login') || page.url().includes('/uas/login')) {
        console.log('LinkedIn session expired. Waiting up to 2 minutes for you to log in...');
        
        // Wait until URL no longer contains login
        await page.waitForFunction(() => !window.location.href.includes('login'), { timeout: 120_000 }).catch(() => {
          throw new Error('Login timed out. Please run the scan again and log in within 2 minutes.');
        });
        
        console.log('Login successful! Navigating back to prospect activity...');
        await page.goto(activityUrl, { timeout: PAGE_TIMEOUT, waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000); // Allow feed to load
      }

      // Wait for posts to appear
      await page.waitForSelector(POST_SELECTOR, { timeout: PAGE_TIMEOUT }).catch(() => {
        // Not all profiles have visible activity — continue gracefully
      });

      const postElements = await page.$$(POST_SELECTOR);
      const limit = Math.min(postElements.length, MAX_POSTS);

      for (let i = 0; i < limit; i++) {
        const el = postElements[i];

        // Extract post text
        const textEl = await el.$(POST_TEXT_SELECTOR);
        const postText = textEl ? (await textEl.innerText()).trim() : '';
        if (!postText || postText.length < 20) continue;

        // Extract post URL (link from the relative timestamp)
        const linkEl = await el.$('a[href*="/posts/"]');
        const postUrl = linkEl
          ? await linkEl.getAttribute('href') ?? ''
          : `${profileUrl}/recent-activity/all/#post-${i}`;
        const canonicalUrl = postUrl.startsWith('http')
          ? postUrl
          : `https://www.linkedin.com${postUrl}`;

        // Extract author name
        const nameEl = await el.$('.update-components-actor__name span[aria-hidden="true"]');
        const authorName = nameEl ? (await nameEl.innerText()).trim() : 'Unknown';

        // Extract approximate date
        const dateEl = await el.$(POST_DATE_SELECTOR);
        let publishedAt: Date | undefined;
        if (dateEl) {
          const dateStr = await dateEl.getAttribute('datetime');
          if (dateStr) publishedAt = new Date(dateStr);
        }

        posts.push({ postUrl: canonicalUrl, postText, authorName, publishedAt });
      }
    } finally {
      await page.close();
      await ctx.close();
    }

    return posts;
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
        : `${profileUrl.replace(/\/?$/, '')}/recent-activity/all/#post-${i}`;

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

  private buildActivityUrl(profileUrl: string): string {
    // Normalise: https://linkedin.com/in/john-doe → https://www.linkedin.com/in/john-doe/recent-activity/all/
    const base = profileUrl.replace(/\/?$/, '');
    return `${base}/recent-activity/all/`;
  }

  private chromePath(): string | undefined {
    return existsSync(CHROME_PATH) ? CHROME_PATH : undefined;
  }
}

