import { chromium, type BrowserContext, type Page } from 'playwright';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ActionResult, CommentInput, LikeInput, LinkedInExecutor, MessageInput, ConnectionInput, ReplyCheckInput, ReplyResult, VisitInput } from './types.js';

export const LINKEDIN_SELECTOR_VERSION = 'linkedin-selectors-v1';

export interface PlaywrightExecutorOptions {
  profileDirectory: string;
  enabled: boolean;
  browserPath?: string;
  timeoutMs?: number;
  selectorVersion?: string;
  launch?: typeof chromium.launchPersistentContext;
  targetIdentity?: string;
  verifyPostState?: (page: Page, action: 'like' | 'comment') => Promise<boolean>;
}

export class PlaywrightExecutor implements LinkedInExecutor {
  private readonly options: PlaywrightExecutorOptions;
  private context?: BrowserContext;
  private stopped = false;

  constructor(options: PlaywrightExecutorOptions) {
    this.options = options;
  }

  stop(): void {
    this.stopped = true;
  }

  private async open(): Promise<{ context: BrowserContext; page: Page }> {
    if (!this.options.enabled) throw new Error('FEATURE_05_BROWSER_DISABLED');
    if (this.stopped) throw new Error('EXECUTION_STOPPED');
    if (!this.options.profileDirectory) throw new Error('SESSION_EXPIRED');

    // Clean up stale Chromium Singleton lock files if present
    try {
      if (fs.existsSync(this.options.profileDirectory)) {
        const files = fs.readdirSync(this.options.profileDirectory);
        for (const file of files) {
          if (file.startsWith('Singleton')) {
            try {
              fs.unlinkSync(path.join(this.options.profileDirectory, file));
            } catch {}
          }
        }
      }
    } catch {}

    const launch = this.options.launch ?? chromium.launchPersistentContext.bind(chromium);
    this.context = await launch(this.options.profileDirectory, {
      headless: false,
      executablePath: this.options.browserPath,
      viewport: { width: 1440, height: 900 },
    });
    const page = (typeof this.context.pages === 'function' && this.context.pages().length > 0)
      ? this.context.pages()[0]
      : await this.context.newPage();
    return { context: this.context, page };
  }

  private async execute(action: string, targetUrl: string, write: (page: Page) => Promise<void>): Promise<ActionResult> {
    const timestamp = new Date().toISOString();
    const selectorVersion = this.options.selectorVersion ?? LINKEDIN_SELECTOR_VERSION;
    const timeoutMs = Math.min(Math.max(this.options.timeoutMs ?? 20_000, 1_000), 60_000);
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    try {
      const opened = await this.open();
      context = opened.context;
      page = opened.page;
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      if (this.stopped) throw new Error('EXECUTION_STOPPED');
      if (this.options.targetIdentity && !page.url().includes(this.options.targetIdentity)) {
        throw new Error('WRONG_TARGET');
      }
      if (/login|checkpoint|captcha/i.test(page.url())) {
        throw new Error(page.url().match(/checkpoint|captcha/i)?.[0].toUpperCase() === 'CAPTCHA' ? 'CHECKPOINT_DETECTED' : 'SESSION_EXPIRED');
      }
      if (/rate-?limit|too many requests/i.test(page.url())) throw new Error('RATE_LIMITED');
      await write(page);
      if (this.stopped) throw new Error('EXECUTION_STOPPED');
      if (action === 'like' || action === 'comment') {
        const verified = this.options.verifyPostState
          ? await this.options.verifyPostState(page, action)
          : false;
        if (!verified) throw new Error('EXECUTION_UNCERTAIN');
        return {
          success: true,
          timestamp,
          outcomeLabel: 'verified',
          audit: {
            eventId: `browser_${timestamp}`,
            payloadHash: createHash('sha256').update(targetUrl + action + timestamp).digest('hex'),
          },
        };
      }
      return {
        success: true,
        timestamp,
        outcomeLabel: 'browser-executed',
        audit: {
          eventId: `browser_${timestamp}`,
          payloadHash: createHash('sha256').update(targetUrl + action + timestamp).digest('hex'),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'EXECUTION_FAILED';
      return {
        success: false,
        errorCode: /timeout/i.test(message) ? 'EXECUTION_TIMEOUT' : message,
        timestamp,
        audit: { eventId: `browser_${timestamp}`, payloadHash: createHash('sha256').update(`${action}:${timestamp}`).digest('hex') },
      };
    } finally {
      if (page && typeof page.close === 'function') {
        await page.close().catch(() => undefined);
      }
      if (context && typeof context.close === 'function') {
        await context.close().catch(() => undefined);
      }
    }
  }

  visitProfile(input: VisitInput): Promise<ActionResult> { return this.execute('visit', input.profileUrl, async () => undefined); }
  sendConnection(input: ConnectionInput): Promise<ActionResult> { return this.execute('connection', input.profileUrl, async () => { throw new Error('SELECTOR_MISMATCH'); }); }
  sendMessage(input: MessageInput): Promise<ActionResult> { return this.execute('message', input.profileUrl, async () => { throw new Error('SELECTOR_MISMATCH'); }); }
  checkReplies(input: ReplyCheckInput): Promise<ReplyResult> { return this.execute('replyCheck', input.profileUrl, async () => undefined).then(result => ({ ...result, hasReplied: false })); }

  likePost(input: LikeInput): Promise<ActionResult> {
    return this.execute('like', input.postUrl, async page => {
      const button = page.locator('[aria-label*="Like"], button:has-text("Like")').first();
      if (!(await button.isVisible().catch(() => false))) throw new Error('SELECTOR_MISMATCH');
      if (/liked|unlike/i.test(await button.getAttribute('aria-label') ?? '')) throw new Error('ACTION_DUPLICATE');
      await button.click({ timeout: this.options.timeoutMs ?? 20_000 });
    });
  }

  publishComment(input: CommentInput): Promise<ActionResult> {
    return this.execute('comment', input.postUrl, async page => {
      // If comment editor is not open, click Comment button to expand it
      const openCommentBtn = page.locator('button[aria-label*="Comment"], button:has-text("Comment")').first();
      if (await openCommentBtn.isVisible().catch(() => false)) {
        await openCommentBtn.click().catch(() => {});
        await page.waitForTimeout(1000);
      }
      const editor = page.locator('.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"], [contenteditable="true"], textarea').first();
      if (!(await editor.isVisible({ timeout: 5000 }).catch(() => false))) {
        throw new Error('SELECTOR_MISMATCH');
      }
      await editor.click();
      await page.keyboard.type(input.comment, { delay: 10 });
      await page.waitForTimeout(500);
      const submit = page.locator('button.comments-comment-box__submit-button, button.comments-comment-texteditor__submit-button, button:has-text("Post"), button:has-text("Comment")').first();
      if (!(await submit.isVisible().catch(() => false))) throw new Error('SELECTOR_MISMATCH');
      await submit.click({ timeout: this.options.timeoutMs ?? 20_000 });
      await page.waitForTimeout(2000);
    });
  }
}
