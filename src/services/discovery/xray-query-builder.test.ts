import { describe, expect, it } from 'vitest';
import {
  buildXrayQueries,
  buildXrayQueriesFromCriteria,
  DEFAULT_XRAY_AGENCY_TERMS,
  DEFAULT_XRAY_TITLES,
} from './xray-query-builder.js';

describe('buildXrayQueries', () => {
  it('builds the documented example shape from explicit criteria', () => {
    const [query] = buildXrayQueries({
      titles: ['Founder', 'Managing Director', 'Managing Partner', 'Commercial Director'],
      agencyTerms: ['recruitment', 'executive search', 'staffing'],
      industries: ['tech', 'engineering', 'finance', 'life sciences'],
      locations: ['United States', 'United Kingdom'],
      maxQueries: 3,
    });
    expect(query).toContain('site:linkedin.com/in/');
    expect(query).toContain('("Founder" OR "Managing Director" OR "Managing Partner" OR "Commercial Director")');
    expect(query).toContain('("recruitment" OR "executive search" OR "staffing")');
    expect(query).toContain('("tech" OR "engineering" OR "finance" OR "life sciences")');
    expect(query).toContain('("United States")');
    expect(query).toContain('-intitle:jobs');
    expect(query).not.toContain('-intitle:recruitment');
  });

  it('emits one bounded variant per location', () => {
    const queries = buildXrayQueries({
      titles: ['Founder'],
      industries: ['tech'],
      locations: ['London', 'Berlin', 'Paris', 'Madrid'],
      maxQueries: 3,
    });
    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain('("London")');
    expect(queries[2]).toContain('("Paris")');
  });

  it('falls back to RecruitmentOS defaults for blank criteria', () => {
    const [query] = buildXrayQueries({});
    for (const title of DEFAULT_XRAY_TITLES) expect(query).toContain(title);
    for (const term of DEFAULT_XRAY_AGENCY_TERMS) expect(query).toContain(term);
  });

  it('dedupes case-insensitive duplicate terms and drops blanks', () => {
    const [query] = buildXrayQueries({
      titles: ['Founder', ' founder ', '', 'FOUNDER'],
      industries: ['tech'],
    });
    expect(query.match(/"Founder"/g)).toHaveLength(1);
  });

  it('produces a single query when no locations are given', () => {
    expect(buildXrayQueries({ titles: ['Founder'], industries: ['tech'] })).toHaveLength(1);
  });

  it('sanitizes injected syntax and keeps oversized criteria queries well formed', () => {
    const [query] = buildXrayQueries({
      titles: ['Founder" OR site:example.com', 'x'.repeat(600)],
      industries: ['tech) OR (finance', 'y'.repeat(600)],
      locations: ['London" OR "Berlin'],
    });

    expect(query.length).toBeLessThanOrEqual(500);
    expect(query).not.toContain('site:example.com');
    expect(query).not.toContain('Founder" OR');
    expect((query.match(/"/g) ?? []).length % 2).toBe(0);
    expect((query.match(/\(/g) ?? []).length).toBe((query.match(/\)/g) ?? []).length);
  });
});

describe('buildXrayQueriesFromCriteria', () => {
  it('derives titles, niches, and geography from saved ICP criteria', () => {
    const queries = buildXrayQueriesFromCriteria({
      titles: ['Founder'],
      industry: ['fintech'],
      geography: ['London'],
      qualificationThreshold: 80,
      reviewThreshold: 50,
    } as never);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('"Founder"');
    expect(queries[0]).toContain('"fintech"');
    expect(queries[0]).toContain('("London")');
  });

  it('lets explicit override locations win over saved geography', () => {
    const queries = buildXrayQueriesFromCriteria(
      { titles: ['Founder'], industry: ['tech'], geography: ['London'] } as never,
      { locations: ['Berlin'] },
    );
    expect(queries[0]).toContain('("Berlin")');
    expect(queries[0]).not.toContain('London');
  });
});
