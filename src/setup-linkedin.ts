import 'dotenv/config';
import { chromium } from 'playwright';

const profileDirectory =
  process.env.BROWSER_PROFILE_DIR ??
  process.env.LINKEDIN_PROFILE_DIR ??
  '.linkedin-profile';

console.log('Opening LinkedIn in a persistent browser profile.');
console.log('Log in manually, confirm the feed loads, then close the browser window.');

const context = await chromium.launchPersistentContext(profileDirectory, {
  headless: false,
  viewport: { width: 1440, height: 900 },
});

const pages = context.pages();
const page = pages[0] ?? await context.newPage();
await page.goto('https://www.linkedin.com/feed/', {
  waitUntil: 'domcontentloaded',
  timeout: 30_000,
});

await page.waitForEvent('close', { timeout: 0 });
await context.close().catch(() => undefined);
console.log('LinkedIn browser profile saved.');
