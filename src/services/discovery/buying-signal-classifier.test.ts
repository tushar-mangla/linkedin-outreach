import { describe, expect, it } from 'vitest';
import {
  BuyingSignalClassifier,
  FakeBuyingSignalProvider,
  SIGNAL_QUALIFICATION_THRESHOLD,
  SIGNAL_REVIEW_THRESHOLD,
  extractContacts,
  isVerbatimQuote,
  runNegativeGate,
  type BuyingSignalProvider,
} from './buying-signal-classifier.js';

describe('runNegativeGate (Layer 1)', () => {
  it('drops #OpenToWork posts', () => {
    const result = runNegativeGate({
      postText: 'Excited to announce I am #OpenToWork for new roles!',
    });
    expect(result.passed).toBe(false);
  });

  it('drops job-seeker language', () => {
    expect(runNegativeGate({ postText: 'I am open to work and seeking new opportunities.' }).passed).toBe(false);
    expect(runNegativeGate({ postText: 'Looking for a new role in recruitment.' }).passed).toBe(false);
  });

  it('drops resume-sharing posts', () => {
    expect(runNegativeGate({ postText: 'Here is my resume, happy to share my CV.' }).passed).toBe(false);
  });

  it('drops blacklisted companies', () => {
    const result = runNegativeGate({
      postText: 'We are growing our agency this year.',
      authorCompany: 'Acme Staffing',
      blacklistedCompanies: ['Acme Staffing'],
    });
    expect(result.passed).toBe(false);
  });

  it('passes genuine agency-owner posts', () => {
    const result = runNegativeGate({
      postText: 'Manual sourcing is killing our margins this quarter.',
    });
    expect(result.passed).toBe(true);
  });
});

describe('extractContacts (Layer 2)', () => {
  it('extracts emails', () => {
    const { emails } = extractContacts('Reach me at jane.doe@recruitment.co.uk or john@agency.com');
    expect(emails).toContain('jane.doe@recruitment.co.uk');
    expect(emails).toContain('john@agency.com');
  });

  it('extracts URLs', () => {
    const { links } = extractContacts('Check https://www.acme.com and http://blog.acme.io/post');
    expect(links).toContain('https://www.acme.com');
    expect(links).toContain('http://blog.acme.io/post');
  });

  it('extracts phone numbers', () => {
    const { phones } = extractContacts('Call me at +1 (415) 555-0132 or 020 7946 0958');
    expect(phones.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty arrays when nothing is found', () => {
    const result = extractContacts('No contact details here.');
    expect(result.emails).toEqual([]);
    expect(result.links).toEqual([]);
    expect(result.phones).toEqual([]);
  });
});

describe('isVerbatimQuote (grounding)', () => {
  it('accepts a verbatim substring', () => {
    expect(isVerbatimQuote('Manual sourcing is killing our margins', 'Manual sourcing is killing our margins this quarter.')).toBe(true);
  });

  it('accepts whitespace-normalized matches', () => {
    expect(isVerbatimQuote('Manual  sourcing is killing', 'Manual sourcing is killing our margins')).toBe(true);
  });

  it('rejects fabricated quotes', () => {
    expect(isVerbatimQuote('We are drowning in candidates', 'Manual sourcing is killing our margins')).toBe(false);
  });

  it('rejects null and empty quotes', () => {
    expect(isVerbatimQuote(null, 'some text')).toBe(false);
    expect(isVerbatimQuote('', 'some text')).toBe(false);
  });
});

describe('BuyingSignalClassifier (Layer 3)', () => {
  it('routes a grounded high score to QUALIFIED', async () => {
    const classifier = new BuyingSignalClassifier(new FakeBuyingSignalProvider());
    const result = await classifier.classify({
      postText: 'Manual sourcing is killing our margins this quarter. We need a better pipeline.',
      authorName: 'Jane Doe',
      archetype: 'AGENCY_LEADERSHIP',
    });
    expect(result.passed).toBe(true);
    expect(result.status).toBe('QUALIFIED');
    expect(result.signalScore).toBeGreaterThanOrEqual(SIGNAL_QUALIFICATION_THRESHOLD);
    expect(result.grounded).toBe(true);
    expect(result.signalCategory).toBe('MANUAL_SOURCING_FATIGUE');
  });

  it('caps the score below 40 when the evidence quote is not in the text', async () => {
    const fabricatingProvider: BuyingSignalProvider = {
      providerName: 'fake',
      async scoreSignal() {
        return {
          signalScore: 90,
          confidence: 0.9,
          signalCategory: 'MANUAL_SOURCING_FATIGUE',
          urgency: 'HIGH',
          whatTheyNeed: 'A better sourcing pipeline',
          evidenceQuote: 'We are drowning in candidates', // NOT in the post text
          reasoning: 'test',
        };
      },
    };
    const classifier = new BuyingSignalClassifier(fabricatingProvider);
    const result = await classifier.classify({
      postText: 'Manual sourcing is killing our margins this quarter.',
      archetype: 'AGENCY_LEADERSHIP',
    });
    expect(result.grounded).toBe(false);
    expect(result.signalScore).toBeLessThan(SIGNAL_REVIEW_THRESHOLD); // < 40
    expect(result.status).not.toBe('QUALIFIED');
  });

  it('rejects posts that fail the negative gate before calling the provider', async () => {
    let providerCalls = 0;
    const countingProvider: BuyingSignalProvider = {
      providerName: 'fake',
      async scoreSignal() {
        providerCalls += 1;
        return {
          signalScore: 95,
          confidence: 1,
          signalCategory: 'OTHER',
          urgency: 'HIGH',
          whatTheyNeed: null,
          evidenceQuote: 'x',
          reasoning: 'x',
        };
      },
    };
    const classifier = new BuyingSignalClassifier(countingProvider);
    const result = await classifier.classify({
      postText: 'I am #OpenToWork for new opportunities.',
      archetype: 'AGENCY_LEADERSHIP',
    });
    expect(result.passed).toBe(false);
    expect(providerCalls).toBe(0);
  });

  it('extracts contacts into the classification', async () => {
    const classifier = new BuyingSignalClassifier(new FakeBuyingSignalProvider());
    const result = await classifier.classify({
      postText: 'Manual sourcing is killing us. Email me at jane@agency.com or visit https://agency.com',
      archetype: 'AGENCY_LEADERSHIP',
    });
    expect(result.extractedEmails).toContain('jane@agency.com');
    expect(result.extractedLinks).toContain('https://agency.com');
  });

  it('routes mid scores to REVIEW and low scores to BELOW_THRESHOLD', async () => {
    const midProvider: BuyingSignalProvider = {
      providerName: 'fake',
      async scoreSignal() {
        return {
          signalScore: 55,
          confidence: 0.7,
          signalCategory: 'CONTINGENCY_VS_RETAINER',
          urgency: 'MEDIUM',
          whatTheyNeed: 'Pricing guidance',
          evidenceQuote: 'contingency vs retainer',
          reasoning: 'test',
        };
      },
    };
    const lowProvider: BuyingSignalProvider = {
      providerName: 'fake',
      async scoreSignal() {
        return {
          signalScore: 20,
          confidence: 0.4,
          signalCategory: 'OTHER',
          urgency: 'LOW',
          whatTheyNeed: null,
          evidenceQuote: 'nothing relevant',
          reasoning: 'test',
        };
      },
    };
    const classifier = new BuyingSignalClassifier(midProvider);
    const mid = await classifier.classify({
      postText: 'We debated contingency vs retainer pricing all week.',
      archetype: 'AGENCY_LEADERSHIP',
    });
    expect(mid.status).toBe('REVIEW');
    expect(mid.signalScore).toBeGreaterThanOrEqual(SIGNAL_REVIEW_THRESHOLD);
    expect(mid.signalScore).toBeLessThan(SIGNAL_QUALIFICATION_THRESHOLD);

    const lowClassifier = new BuyingSignalClassifier(lowProvider);
    const low = await lowClassifier.classify({
      postText: 'Just sharing a random thought about nothing relevant here.',
      archetype: 'AGENCY_LEADERSHIP',
    });
    expect(low.status).toBe('BELOW_THRESHOLD');
  });

  it('returns SCORING_FAILED when the provider throws, never a default score', async () => {
    const throwingProvider: BuyingSignalProvider = {
      providerName: 'fake',
      async scoreSignal() {
        throw new Error('provider down');
      },
    };
    const classifier = new BuyingSignalClassifier(throwingProvider);
    const result = await classifier.classify({
      postText: 'Manual sourcing is killing our margins.',
      archetype: 'AGENCY_LEADERSHIP',
    });
    expect(result.status).toBe('SCORING_FAILED');
    expect(result.signalScore).toBe(0);
  });
});