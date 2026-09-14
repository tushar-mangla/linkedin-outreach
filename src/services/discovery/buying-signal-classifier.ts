import type {
  ProspectArchetype,
  ProspectBuyingSignalCategory,
  ProspectBuyingSignalUrgency,
} from '../../types.js';

// ─── Thresholds (plan A9 / D10) ───────────────────────────────────────────────

export const SIGNAL_QUALIFICATION_THRESHOLD = 70;
export const SIGNAL_REVIEW_THRESHOLD = 40;
/** Any score whose evidence quote is not verbatim in the post text is capped below 40. */
export const UNGROUNDED_SCORE_CAP = 39;

// ─── Layer 1: deterministic negative gate ─────────────────────────────────────

const JOB_SEEKER_MARKERS: readonly string[] = [
  '#opentowork',
  '#open to work',
  'open to work',
  'seeking new opportunities',
  'looking for a new role',
  'available for hire',
  'job seeker',
  'actively looking for',
  'my resume',
  'my cv',
  'here is my resume',
  'here is my cv',
  'resume attached',
  'cv attached',
  'share my resume',
  'share my cv',
];

export interface NegativeGateInput {
  postText: string;
  authorCompany?: string;
  blacklistedCompanies?: string[];
}

export interface NegativeGateResult {
  passed: boolean;
  reason?: string;
}

/**
 * Layer 1 — deterministic negative filter. Drops job seekers (#OpenToWork,
 * "open to work", resumes/CVs) and blacklisted companies before any LLM call.
 * Deterministic exclusions are final and never overridden by a signal score.
 */
export function runNegativeGate(input: NegativeGateInput): NegativeGateResult {
  const text = input.postText.toLowerCase();
  for (const marker of JOB_SEEKER_MARKERS) {
    if (text.includes(marker)) {
      return { passed: false, reason: `Job-seeker marker: ${marker}` };
    }
  }

  const company = (input.authorCompany ?? '').toLowerCase();
  for (const blacklisted of input.blacklistedCompanies ?? []) {
    if (company.includes(blacklisted.toLowerCase())) {
      return { passed: false, reason: `Blacklisted company: ${blacklisted}` };
    }
  }

  return { passed: true };
}

// ─── Layer 2: deterministic contact extraction ────────────────────────────────

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
const PHONE_PATTERN = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}(?!\d)/g;

export interface ExtractedContacts {
  emails: string[];
  links: string[];
  phones: string[];
}

/**
 * Layer 2 — regex pre-extraction of emails, URLs, and phone numbers from the
 * post body. Extracted contacts are evidence only; they are never used to
 * initiate outreach without operator approval.
 */
export function extractContacts(text: string): ExtractedContacts {
  const emails = [...new Set((text.match(EMAIL_PATTERN) ?? []).map((e) => e.toLowerCase()))];
  const links = [...new Set(text.match(URL_PATTERN) ?? [])];
  const phones = [...new Set(text.match(PHONE_PATTERN) ?? [])];
  return { emails, links, phones };
}

// ─── Layer 2b: verbatim quote grounding ───────────────────────────────────────

/**
 * Verifies that a claimed evidence quote is a verbatim substring of the post
 * text after whitespace normalization. Fabricated quotes fail grounding.
 */
export function isVerbatimQuote(quote: string | null | undefined, postText: string): boolean {
  if (!quote || !postText) return false;
  const normalizedQuote = quote.replace(/\s+/g, ' ').trim();
  const normalizedText = postText.replace(/\s+/g, ' ').trim();
  if (!normalizedQuote) return false;
  return normalizedText.includes(normalizedQuote);
}

// ─── Layer 3: LLM provider contract ───────────────────────────────────────────

export interface SignalScoreInput {
  postText: string;
  authorName?: string;
  authorHeadline?: string;
  archetype: ProspectArchetype;
}

export interface SignalScoreOutput {
  signalScore: number; // 0-100
  confidence: number; // 0-1
  signalCategory: ProspectBuyingSignalCategory;
  urgency: ProspectBuyingSignalUrgency;
  whatTheyNeed: string | null;
  evidenceQuote: string | null;
  reasoning: string;
}

export interface BuyingSignalProvider {
  readonly providerName: 'luna' | 'gemini' | 'fake';
  scoreSignal(input: SignalScoreInput): Promise<SignalScoreOutput>;
}

// ─── Deterministic fake provider (offline mode) ───────────────────────────────

const FAKE_RULES: ReadonlyArray<{
  keywords: string[];
  category: ProspectBuyingSignalCategory;
  score: number;
  urgency: ProspectBuyingSignalUrgency;
  whatTheyNeed: string;
}> = [
  { keywords: ['manual sourcing'], category: 'MANUAL_SOURCING_FATIGUE', score: 85, urgency: 'HIGH', whatTheyNeed: 'Automated candidate sourcing' },
  { keywords: ['cold calling'], category: 'TIRED_OF_COLD_CALLING', score: 80, urgency: 'HIGH', whatTheyNeed: 'Inbound or referral-based lead generation' },
  { keywords: ['candidate ghosting'], category: 'CANDIDATE_GHOSTING', score: 78, urgency: 'HIGH', whatTheyNeed: 'Candidate engagement tooling' },
  { keywords: ['ats'], category: 'ATS_LIMITATIONS', score: 75, urgency: 'MEDIUM', whatTheyNeed: 'A better ATS or workflow' },
  { keywords: ['client ghosting'], category: 'CLIENT_GHOSTING', score: 72, urgency: 'HIGH', whatTheyNeed: 'Client pipeline visibility' },
  { keywords: ['pipeline'], category: 'BD_PIPELINE_FEAST_FAMINE', score: 72, urgency: 'MEDIUM', whatTheyNeed: 'Consistent BD pipeline' },
  { keywords: ['retainer'], category: 'CONTINGENCY_VS_RETAINER', score: 68, urgency: 'MEDIUM', whatTheyNeed: 'Pricing model guidance' },
  { keywords: ['fee'], category: 'FEE_EROSION', score: 65, urgency: 'MEDIUM', whatTheyNeed: 'Margin protection' },
];

function firstSentence(text: string): string {
  const sentence = text.split(/[.!?]/)[0]?.trim();
  return sentence && sentence.length > 0 ? sentence : text.trim();
}

/** Returns a verbatim slice of the post text around the first matched keyword. */
function quoteFor(text: string, keywords: string[]): string {
  const lower = text.toLowerCase();
  const keyword = keywords.find((k) => lower.includes(k));
  if (!keyword) return firstSentence(text);
  const idx = lower.indexOf(keyword);
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + keyword.length + 60);
  return text.slice(start, end).trim();
}

export class FakeBuyingSignalProvider implements BuyingSignalProvider {
  readonly providerName = 'fake' as const;

  async scoreSignal(input: SignalScoreInput): Promise<SignalScoreOutput> {
    const text = input.postText.toLowerCase();
    const rule = FAKE_RULES.find((r) => r.keywords.some((k) => text.includes(k)));
    if (!rule) {
      return {
        signalScore: 30,
        confidence: 0.5,
        signalCategory: 'OTHER',
        urgency: 'LOW',
        whatTheyNeed: null,
        evidenceQuote: firstSentence(input.postText),
        reasoning: 'No known buying-signal keyword matched (fake provider).',
      };
    }
    return {
      signalScore: rule.score,
      confidence: 0.8,
      signalCategory: rule.category,
      urgency: rule.urgency,
      whatTheyNeed: rule.whatTheyNeed,
      evidenceQuote: quoteFor(input.postText, rule.keywords),
      reasoning: `Matched ${rule.keywords.join(', ')} (fake provider).`,
    };
  }
}

// ─── Classifier ───────────────────────────────────────────────────────────────

export type SignalStatus = 'QUALIFIED' | 'REVIEW' | 'BELOW_THRESHOLD' | 'REJECTED' | 'SCORING_FAILED';

export interface BuyingSignalClassification {
  passed: boolean;
  rejectionReason?: string;
  extractedEmails: string[];
  extractedLinks: string[];
  extractedPhones: string[];
  signalScore: number;
  signalCategory: ProspectBuyingSignalCategory;
  urgency: ProspectBuyingSignalUrgency;
  whatTheyNeed: string | null;
  evidenceQuote: string | null;
  grounded: boolean;
  provider: 'luna' | 'gemini' | 'fake';
  status: SignalStatus;
}

export interface ClassifyInput {
  postText: string;
  authorName?: string;
  authorHeadline?: string;
  authorCompany?: string;
  archetype: ProspectArchetype;
  blacklistedCompanies?: string[];
}

/**
 * Hybrid buying-signal classifier:
 *   Layer 1 — deterministic negative gate (job seekers, resumes, blacklist)
 *   Layer 2 — regex contact extraction (emails, URLs, phones)
 *   Layer 3 — LLM classification with verbatim-quote grounding
 *
 * A claim whose evidence quote is not a verbatim substring of the post text is
 * capped below 40, so it can never qualify. Invalid provider output is a
 * scoring failure, never a default score.
 */
export class BuyingSignalClassifier {
  private readonly provider: BuyingSignalProvider;

  constructor(provider: BuyingSignalProvider = new FakeBuyingSignalProvider()) {
    this.provider = provider;
  }

  async classify(input: ClassifyInput): Promise<BuyingSignalClassification> {
    // Layer 1 — deterministic negative gate before any LLM call.
    const gate = runNegativeGate({
      postText: input.postText,
      authorCompany: input.authorCompany,
      blacklistedCompanies: input.blacklistedCompanies,
    });
    if (!gate.passed) {
      return {
        passed: false,
        rejectionReason: gate.reason,
        extractedEmails: [],
        extractedLinks: [],
        extractedPhones: [],
        signalScore: 0,
        signalCategory: 'OTHER',
        urgency: 'LOW',
        whatTheyNeed: null,
        evidenceQuote: null,
        grounded: false,
        provider: this.provider.providerName,
        status: 'REJECTED',
      };
    }

    // Layer 2 — regex contact pre-extraction.
    const contacts = extractContacts(input.postText);

    // Layer 3 — LLM classification.
    let output: SignalScoreOutput;
    try {
      output = await this.provider.scoreSignal({
        postText: input.postText,
        authorName: input.authorName,
        authorHeadline: input.authorHeadline,
        archetype: input.archetype,
      });
    } catch {
      return {
        passed: true,
        extractedEmails: contacts.emails,
        extractedLinks: contacts.links,
        extractedPhones: contacts.phones,
        signalScore: 0,
        signalCategory: 'OTHER',
        urgency: 'LOW',
        whatTheyNeed: null,
        evidenceQuote: null,
        grounded: false,
        provider: this.provider.providerName,
        status: 'SCORING_FAILED',
      };
    }

    // Grounding — every persisted quote must be verbatim in the post text.
    const grounded = isVerbatimQuote(output.evidenceQuote, input.postText);
    let score = output.signalScore;
    if (!grounded) {
      score = Math.min(score, UNGROUNDED_SCORE_CAP);
    }

    let status: SignalStatus;
    if (score >= SIGNAL_QUALIFICATION_THRESHOLD) status = 'QUALIFIED';
    else if (score >= SIGNAL_REVIEW_THRESHOLD) status = 'REVIEW';
    else status = 'BELOW_THRESHOLD';

    return {
      passed: true,
      extractedEmails: contacts.emails,
      extractedLinks: contacts.links,
      extractedPhones: contacts.phones,
      signalScore: score,
      signalCategory: output.signalCategory,
      urgency: output.urgency,
      whatTheyNeed: output.whatTheyNeed,
      evidenceQuote: output.evidenceQuote,
      grounded,
      provider: this.provider.providerName,
      status,
    };
  }
}
