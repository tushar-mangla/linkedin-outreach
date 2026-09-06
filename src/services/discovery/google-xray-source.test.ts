import { describe, expect, it } from 'vitest';
import {
  GoogleXraySource,
  normalizeCanonicalLinkedinUrl,
  parseXrayHtml,
  XrayBlockedError,
  XrayNetworkError,
  XrayRateLimitedError,
} from './google-xray-source.js';

// Offline fixture: Google-style result page. No live network access is used.
const GOOGLE_FIXTURE = `
<html><body>
<div class="g">
  <a href="https://www.linkedin.com/in/john-smith?utm_source=google&utm_medium=serp">John Smith - Founder at Acme Search | LinkedIn</a>
  <span>Founder at Acme Search, London. Specialist tech recruitment agency.</span>
</div>
<div class="g">
  <a href="https://www.google.com/url?q=https://www.linkedin.com/in/jane-doe/%3Ftrk%3Dpublic_profile&amp;sa=U">Jane Doe – Managing Director, FinTalent Partners | LinkedIn</a>
  <span>Managing Director at FinTalent Partners. Finance executive search.</span>
</div>
<div class="g">
  <a href="https://www.linkedin.com/in/JOHN-SMITH/">John Smith - Founder at Acme Search | LinkedIn</a>
  <span>Duplicate of the first result with different casing and slash.</span>
</div>
<div class="g">
  <a href="https://www.linkedin.com/company/acme-search">Acme Search | LinkedIn</a>
  <span>Company page: must be skipped.</span>
</div>
<div class="g">
  <a href="https://www.linkedin.com/jobs/view/12345">Recruiter job posting | LinkedIn</a>
  <span>Jobs URL: must be skipped.</span>
</div>
<div class="g">
  <a href="not-a-url">Broken link | LinkedIn</a>
  <span>Invalid URL: must be skipped.</span>
</div>
</body></html>`;

describe('normalizeCanonicalLinkedinUrl', () => {
  it('strips tracking params and normalizes to the canonical www profile URL', () => {
    expect(normalizeCanonicalLinkedinUrl('https://www.linkedin.com/in/John-Smith?utm_source=x#frag')).toBe(
      'https://www.linkedin.com/in/john-smith',
    );
  });

  it('unwraps redirect wrappers', () => {
    expect(
      normalizeCanonicalLinkedinUrl('https://www.google.com/url?q=https://www.linkedin.com/in/jane-doe/&sa=U'),
    ).toBe('https://www.linkedin.com/in/jane-doe');
  });

  it('rejects non-profile LinkedIn URLs', () => {
    expect(() => normalizeCanonicalLinkedinUrl('https://www.linkedin.com/company/acme')).toThrow();
    expect(() => normalizeCanonicalLinkedinUrl('not-a-url')).toThrow();
  });
});

describe('parseXrayHtml', () => {
  it('extracts profile candidates and skips non-profile/invalid URLs', () => {
    const results = parseXrayHtml(GOOGLE_FIXTURE, { locationDefault: 'United Kingdom' });
    expect(results).toHaveLength(2);

    const [john, jane] = results;
    expect(john.name).toBe('John Smith');
    expect(john.title).toBe('Founder');
    expect(john.company).toBe('Acme Search');
    expect(john.location).toBe('United Kingdom');
    expect(john.linkedinUrl).toBe('https://www.linkedin.com/in/john-smith');

    expect(jane.name).toBe('Jane Doe');
    expect(jane.title).toBe('Managing Director');
    expect(jane.company).toBe('FinTalent Partners');
    expect(jane.linkedinUrl).toBe('https://www.linkedin.com/in/jane-doe');
  });

  it('dedupes the same handle across casing/trailing-slash variants', () => {
    const results = parseXrayHtml(GOOGLE_FIXTURE);
    const urls = results.map((r) => r.linkedinUrl);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('leaves missing fields empty instead of inventing facts', () => {
    const results = parseXrayHtml(
      `<a href="https://www.linkedin.com/in/mystery-person">Mystery Person | LinkedIn</a>`,
    );
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('');
    expect(results[0].company).toBe('');
  });
});

describe('GoogleXraySource error handling (mocked fetch, no network)', () => {
  it('falls back to DuckDuckGo HTML when Google blocks the request', async () => {
    const urls: string[] = [];
    const source = new GoogleXraySource(async (url) => {
      urls.push(url);
      if (url.includes('google.com')) return { status: 403, body: '<html>captcha challenge</html>' };
      return {
        status: 200,
        body: '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fjane-doe">Jane Doe - Founder at FinTalent Partners</a><span>Founder of a boutique agency, based in London.</span><a href="https://www.linkedin.com/in/john-smith">John Smith - Managing Director, Acme Search</a>',
      };
    });
    const html = await source.searchHtml('site:linkedin.com/in/ "Founder"');
    expect(parseXrayHtml(html)).toMatchObject([
      { name: 'Jane Doe', title: 'Founder', company: 'FinTalent Partners', location: 'London' },
      { name: 'John Smith', title: 'Managing Director', company: 'Acme Search' },
    ]);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('google.com');
    expect(urls[1]).toContain('html.duckduckgo.com/html/?q=');
  });

  it('fails closed on rate limits and preserves Retry-After', async () => {
    const urls: string[] = [];
    const source = new GoogleXraySource(async (url) => {
      urls.push(url);
      if (url.includes('google.com')) return { status: 429, body: 'too many requests', retryAfter: '120' };
      return { status: 429, body: 'too many requests', retryAfter: '120' };
    });
    await expect(source.searchHtml('site:linkedin.com/in/')).rejects.toMatchObject({
      name: 'XrayRateLimitedError',
      retryAfterMs: 120_000,
    });
    expect(urls).toHaveLength(2);
  });

  it('maps repeated blocks to a blocked error', async () => {
    const source = new GoogleXraySource(async () => ({ status: 200, body: '<html>unusual traffic captcha</html>' }));
    await expect(source.searchHtml('site:linkedin.com/in/')).rejects.toBeInstanceOf(XrayBlockedError);
  });

  it('maps fetch failures to a network error', async () => {
    const source = new GoogleXraySource(async () => {
      throw new Error('socket hang up');
    });
    await expect(source.searchHtml('site:linkedin.com/in/')).rejects.toBeInstanceOf(XrayNetworkError);
  });
});
