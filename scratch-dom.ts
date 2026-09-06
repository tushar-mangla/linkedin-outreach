import { chromium } from 'playwright';

async function main() {
  const ctx = await chromium.launchPersistentContext('.linkedin-profile', { headless: false });
  const page = await ctx.newPage();
  await page.goto('https://www.linkedin.com/in/kieran-fielding-3ba866150/recent-activity/shares/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(4000);
  
  const posts = await page.evaluate(() => {
    // LinkedIn often uses these classes for posts
    const postEls = Array.from(document.querySelectorAll('.profile-creator-shared-feed-update__container, .feed-shared-update-v2, [data-urn*="activity"]'));
    return postEls.map(el => {
      const text = el.querySelector('.feed-shared-text, .update-components-text, .break-words')?.textContent?.trim();
      const time = el.querySelector('time, .update-components-actor__sub-description')?.textContent?.trim();
      return { className: el.className, text: text?.slice(0, 50), time };
    }).filter(p => p.text);
  });
  
  console.log(JSON.stringify(posts, null, 2));
  await ctx.close();
}
main().catch(console.error);
