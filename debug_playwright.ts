import { chromium } from 'playwright';
import path from 'path';

(async () => {
  const profileDir = process.env.BROWSER_PROFILE_DIR || '/Users/tusharmangla/.opencli/clis/chrome-profile';
  console.log('Using profile:', profileDir);
  
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
  });
  
  const page = await context.newPage();
  const url = 'https://www.linkedin.com/in/naz-shikder/posts/activity-growth-update';
  console.log('Navigating to', url);
  
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000); // let it load
  
  // try clicking comment button
  const openCommentBtn = page.locator('button[aria-label*="Comment"], button:has-text("Comment")').first();
  if (await openCommentBtn.isVisible().catch(() => false)) {
      console.log("Found comment button, clicking...");
      await openCommentBtn.click().catch(() => {});
      await page.waitForTimeout(1000);
  }

  // take screenshot
  const screenshotPath = path.resolve('./failing_post.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`Saved screenshot to ${screenshotPath}`);

  // try to find editor
  const editor = page.locator('.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"], [contenteditable="true"], textarea').first();
  console.log('Editor visible?', await editor.isVisible().catch(() => false));
  
  await context.close();
})().catch(console.error);
