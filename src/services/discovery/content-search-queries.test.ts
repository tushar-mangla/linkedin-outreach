import { describe, expect, it } from 'vitest';
import {
  BD_QUERY_PRESETS,
  CANDIDATE_QUERY_PRESETS,
  buildLinkedInContentSearchUrl,
  getContentSearchQueryPresets,
} from './content-search-queries.js';

describe('buildLinkedInContentSearchUrl', () => {
  it('builds a content-search URL with encoded keywords and the past-24h default', () => {
    const url = buildLinkedInContentSearchUrl('recruitment agency owner clients');
    expect(url).toBe(
      'https://www.linkedin.com/search/results/content/?keywords=recruitment%20agency%20owner%20clients&datePosted=%5B%22past-24h%22%5D&sortBy=%5B%22date_posted%22%5D',
    );
  });

  it('supports past-week and past-month recency windows', () => {
    expect(buildLinkedInContentSearchUrl('sourcing candidates manually', 'past-week')).toContain(
      'datePosted=%5B%22past-week%22%5D',
    );
    expect(buildLinkedInContentSearchUrl('sourcing candidates manually', 'past-month')).toContain(
      'datePosted=%5B%22past-month%22%5D',
    );
  });

  it('encodes special characters in the query', () => {
    const url = buildLinkedInContentSearchUrl('we are hiring & recruiting');
    expect(url).toContain('keywords=we%20are%20hiring%20%26%20recruiting');
  });

  it('sorts by date_posted', () => {
    const url = buildLinkedInContentSearchUrl('agency growth');
    expect(url).toContain('sortBy=%5B%22date_posted%22%5D');
  });
});

describe('content search query presets', () => {
  it('keeps a 75/25 BD-to-candidate ratio', () => {
    const presets = getContentSearchQueryPresets();
    const bdCount = presets.filter((q) => BD_QUERY_PRESETS.includes(q)).length;
    expect(bdCount / presets.length).toBeCloseTo(0.75, 5);
  });

  it('enforces 3-6 word queries', () => {
    for (const query of getContentSearchQueryPresets()) {
      const words = query.split(/\s+/).filter(Boolean);
      expect(words.length).toBeGreaterThanOrEqual(3);
      expect(words.length).toBeLessThanOrEqual(6);
    }
  });

  it('separates BD presets from candidate presets', () => {
    expect(BD_QUERY_PRESETS.length).toBeGreaterThan(0);
    expect(CANDIDATE_QUERY_PRESETS.length).toBeGreaterThan(0);
    expect(BD_QUERY_PRESETS.some((q) => q.includes('hiring recruiters'))).toBe(false);
    expect(CANDIDATE_QUERY_PRESETS.some((q) => q.includes('cold calling'))).toBe(false);
  });
});