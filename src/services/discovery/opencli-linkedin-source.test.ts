import { describe, expect, it, vi } from 'vitest';
import {
  OpenCliLinkedinSource,
  OpenCliUnavailableError,
  buildFacetedLinkedinSearchUrl,
  cleanLinkedinKeywords,
  parseOpenCliLinkedinMarkdown,
} from './opencli-linkedin-source.js';

const LINKEDIN_RESULTS_FIXTURE = `
# People search results

[

Beckie Blackburn-Cooper

](https://www.linkedin.com/in/beckie-blackburn-cooper-123/?trk=public_profile) • 1st
Founder & Managing Director at B B C Recruitment
Current: Founder & Managing Director at B B C Recruitment
Greater Birmingham, England, United Kingdom
[Mark Whitby](https://www.linkedin.com/in/mark-whitby/) & [3 other mutual connections](https://www.linkedin.com/search/results/people/?origin=SHARED_CONNECTIONS)

* * *

[Sheila Musgrove](https://www.linkedin.com/in/sheila-musgrove/) • 2nd
Founder and CEO at TAG Recruitment Group
Current: Founder and CEO at TAG Recruitment Group
Calgary, Alberta, Canada
[Michael Alexander](https://www.linkedin.com/in/michael-alexander/) and [2 other connections](https://www.linkedin.com/search/results/people/?origin=SHARED_CONNECTIONS)

[Beckie Blackburn-Cooper](https://www.linkedin.com/in/BECKIE-BLACKBURN-COOPER-123/)
Founder & Managing Director at B B C Recruitment
Greater Birmingham, England, United Kingdom

[A Company Page](https://www.linkedin.com/company/example-recruitment/)
Not a person
`;

describe('parseOpenCliLinkedinMarkdown', () => {
  it('extracts, canonicalizes, and deduplicates LinkedIn people-search results offline', () => {
    const results = parseOpenCliLinkedinMarkdown(LINKEDIN_RESULTS_FIXTURE);

    expect(results).toEqual([
      {
        name: 'Beckie Blackburn-Cooper',
        title: 'Founder & Managing Director',
        company: 'B B C Recruitment',
        location: 'Greater Birmingham, England, United Kingdom',
        linkedinUrl: 'https://www.linkedin.com/in/beckie-blackburn-cooper-123',
      },
      {
        name: 'Sheila Musgrove',
        title: 'Founder and CEO',
        company: 'TAG Recruitment Group',
        location: 'Calgary, Alberta, Canada',
        linkedinUrl: 'https://www.linkedin.com/in/sheila-musgrove',
      },
    ]);
    expect(results.map(({ name }) => name)).not.toContain('Mark Whitby');
    expect(results.map(({ name }) => name)).not.toContain('Michael Alexander');
  });

  it('uses a headline when Current evidence is unavailable', () => {
    const results = parseOpenCliLinkedinMarkdown(
      '[Alex Morgan](https://www.linkedin.com/in/alex-morgan/)\nManaging Partner at Northstar Search\nLondon, England, United Kingdom',
    );

    expect(results).toEqual([{
      name: 'Alex Morgan',
      title: 'Managing Partner',
      company: 'Northstar Search',
      location: 'London, England, United Kingdom',
      linkedinUrl: 'https://www.linkedin.com/in/alex-morgan',
    }]);
  });

  it('defaults missing title, company, and location attributes', () => {
    expect(parseOpenCliLinkedinMarkdown(
      '[Alex Morgan](https://www.linkedin.com/in/alex-morgan/)',
    )).toEqual([{
      name: 'Alex Morgan',
      title: 'Founder & Managing Director - Boutique Recruitment',
      company: 'Boutique Recruitment Agency',
      location: 'United States / Global',
      linkedinUrl: 'https://www.linkedin.com/in/alex-morgan',
    }]);

    expect(parseOpenCliLinkedinMarkdown(
      '[Jamie Lee](https://www.linkedin.com/in/jamie-lee/)\nExperienced recruitment leader',
    )).toEqual([{
      name: 'Jamie Lee',
      title: 'Experienced recruitment leader',
      company: 'Boutique Recruitment Agency',
      location: 'United States / Global',
      linkedinUrl: 'https://www.linkedin.com/in/jamie-lee',
    }]);
  });

  it('ignores markdown link lines when selecting headline and location text', () => {
    const results = parseOpenCliLinkedinMarkdown(
      '[Alex Morgan](https://www.linkedin.com/in/alex-morgan/)\n[](https://www.linkedin.com/in/alex-morgan/)\nCurrent: Partner at Northstar Search\nLondon, England, United Kingdom',
    );

    expect(results).toEqual([{
      name: 'Alex Morgan',
      title: 'Partner',
      company: 'Northstar Search',
      location: 'London, England, United Kingdom',
      linkedinUrl: 'https://www.linkedin.com/in/alex-morgan',
    }]);
  });
});

describe('buildFacetedLinkedinSearchUrl', () => {
  it('builds exact faceted LinkedIn search URL with keywords, geoUrn, industry, and pagination', () => {
    expect(buildFacetedLinkedinSearchUrl('director', 1)).toBe(
      'https://www.linkedin.com/search/results/people/?keywords=director&origin=FACETED_SEARCH&geoUrn=%5B%22103644278%22%2C%22101165590%22%5D&industry=%5B%22104%22%5D&page=1&spellCorrectionEnabled=true&prioritizeMessage=false',
    );

    expect(buildFacetedLinkedinSearchUrl('director', 2)).toBe(
      'https://www.linkedin.com/search/results/people/?keywords=director&origin=FACETED_SEARCH&geoUrn=%5B%22103644278%22%2C%22101165590%22%5D&industry=%5B%22104%22%5D&page=2&spellCorrectionEnabled=true&prioritizeMessage=false',
    );
  });
});

describe('OpenCliLinkedinSource', () => {
  it('removes Google X-Ray operators, punctuation, and boolean words', () => {
    expect(cleanLinkedinKeywords(
      'site:linkedin.com/in/ ("Founder" OR "Managing Director") -intitle:jobs recruitment',
    )).toBe('Founder Managing Director recruitment');
    expect(cleanLinkedinKeywords('site:linkedin.com/in -intitle:profiles')).toBe(
      'boutique recruitment founder',
    );
    expect(cleanLinkedinKeywords('site:linkedin.com/in -intitle:jobs OR OR')).toBe(
      'boutique recruitment founder',
    );
    expect(cleanLinkedinKeywords("(founder AND 'recruitment') NOT agency")).toBe('founder recruitment agency');
    expect(cleanLinkedinKeywords('  boutique   recruitment founder  ')).toBe('boutique recruitment founder');
  });

  it('opens the authenticated LinkedIn search tab, unwraps extracted markdown, and parses it', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce('{"page":"tab-42"}')
      .mockResolvedValueOnce(JSON.stringify({
        url: 'https://www.linkedin.com/search/results/people/',
        title: 'People search results',
        content: LINKEDIN_RESULTS_FIXTURE,
      }));
    const source = new OpenCliLinkedinSource({ runner });

    const results = await source.search('site:linkedin.com/in/ boutique recruitment founder -intitle:jobs');

    expect(runner).toHaveBeenNthCalledWith(
      1,
      ['browser', 'linkedin', 'open', 'https://www.linkedin.com/search/results/people/?keywords=boutique%20recruitment%20founder&origin=FACETED_SEARCH&geoUrn=%5B%22103644278%22%2C%22101165590%22%5D&industry=%5B%22104%22%5D&page=1&spellCorrectionEnabled=true&prioritizeMessage=false'],
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
    expect(runner).toHaveBeenNthCalledWith(2, ['browser', 'linkedin', 'extract', '--tab', 'tab-42'], expect.any(Object));
    expect(results).toHaveLength(2);
  });

  it('supports explicit page numbers in search', async () => {
    const runner = vi.fn()
      .mockResolvedValueOnce('{"page":"tab-42"}')
      .mockResolvedValueOnce(JSON.stringify({
        content: LINKEDIN_RESULTS_FIXTURE,
      }));
    const source = new OpenCliLinkedinSource({ runner });

    await source.search('director', 2);

    expect(runner).toHaveBeenNthCalledWith(
      1,
      ['browser', 'linkedin', 'open', 'https://www.linkedin.com/search/results/people/?keywords=director&origin=FACETED_SEARCH&geoUrn=%5B%22103644278%22%2C%22101165590%22%5D&industry=%5B%22104%22%5D&page=2&spellCorrectionEnabled=true&prioritizeMessage=false'],
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });

  it('classifies a missing OpenCLI executable as unavailable for provider fallback', async () => {
    const source = new OpenCliLinkedinSource({
      runner: async () => {
        const error = Object.assign(new Error('spawn opencli ENOENT'), { code: 'ENOENT' });
        throw error;
      },
    });

    await expect(source.search('founder')).rejects.toBeInstanceOf(OpenCliUnavailableError);
  });
});

