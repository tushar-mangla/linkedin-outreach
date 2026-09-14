import type {
  BuyingSignalProvider,
  SignalScoreInput,
  SignalScoreOutput,
} from './buying-signal-classifier.js';

// ─── LunaBuyingSignalProvider ─────────────────────────────────────────────────
//
// Uses the codex-everywhere OpenAI-compatible HTTP API with the gpt-5.6-luna model
// to classify buying signals from LinkedIn post text. Mirrors
// LunaEngagementProvider (src/services/engagement/luna-engagement-provider.ts).
//
// Required env vars:
//   CODEX_EVERYWHERE_API_KEY  — API key for codex-everywhere
//   CODEX_EVERYWHERE_BASE_URL — Base URL (default: https://api.codex-everywhere.com/v1)

const LUNA_BASE_URL = 'https://api.codex-everywhere.com/v1';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const TIMEOUT_MS = 30_000;

const SIGNAL_CATEGORIES = [
  'BD_PIPELINE_FEAST_FAMINE',
  'COLD_OUTREACH_FATIGUE',
  'CONTINGENCY_VS_RETAINER',
  'FEE_EROSION',
  'CLIENT_GHOSTING',
  'TIRED_OF_COLD_CALLING',
  'MANUAL_SOURCING_FATIGUE',
  'CANDIDATE_GHOSTING',
  'ATS_LIMITATIONS',
  'OTHER',
] as const;

export class LunaBuyingSignalProvider implements BuyingSignalProvider {
  readonly providerName: 'luna' | 'gemini';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly isGemini: boolean;

  constructor(opts?: { apiKey?: string; baseUrl?: string }) {
    const geminiKey = process.env.GEMINI_API_KEY ?? '';
    this.isGemini = !opts?.apiKey && !!geminiKey;
    this.apiKey = opts?.apiKey ?? (geminiKey || process.env.CODEX_EVERYWHERE_API_KEY || '');
    this.baseUrl = opts?.baseUrl ?? (this.isGemini ? (process.env.GEMINI_BASE_URL ?? GEMINI_BASE_URL) : (process.env.CODEX_EVERYWHERE_BASE_URL ?? LUNA_BASE_URL));
    this.model = this.isGemini ? (process.env.GEMINI_MODEL ?? 'gemini-2.5-flash') : (process.env.CODEX_EVERYWHERE_MODEL ?? 'gpt-5.6-luna');
    this.providerName = this.isGemini ? 'gemini' : 'luna';

    if (!this.apiKey) {
      throw new Error(
        'LunaBuyingSignalProvider: GEMINI_API_KEY or CODEX_EVERYWHERE_API_KEY is not set. ' +
        'Add it to your .env file.',
      );
    }
  }

  async scoreSignal(input: SignalScoreInput): Promise<SignalScoreOutput> {
    const systemPrompt = [
      'You are a buying-signal analyst for RecruitmentOS, an outreach platform for staffing and recruitment agency operators.',
      'You classify LinkedIn posts written by recruitment agency owners (Archetype A) or hiring leaders (Archetype B).',
      'Rules:',
      '- signalScore: 0-100, how strongly the author is signalling a buying need.',
      '- confidence: 0-1.',
      `- signalCategory: one of ${SIGNAL_CATEGORIES.join(', ')}.`,
      "- urgency: 'HIGH' | 'MEDIUM' | 'LOW'.",
      '- whatTheyNeed: a short phrase describing the product/service the author would buy.',
      '- evidenceQuote: a VERBATIM quote copied character-for-character from the post text that supports the category.',
      '- reasoning: one sentence justifying the score.',
      'Return ONLY a JSON object with keys: signalScore, confidence, signalCategory, urgency, whatTheyNeed, evidenceQuote, reasoning.',
    ].join('\n');

    const userPrompt = [
      `Archetype: ${input.archetype}`,
      input.authorName ? `Author: ${input.authorName}` : '',
      input.authorHeadline ? `Headline: ${input.authorHeadline}` : '',
      '',
      'Post text:',
      '"""',
      input.postText,
      '"""',
    ].filter(Boolean).join('\n');

    const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let content: string;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
           model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
          max_tokens: 300,
        }),
        signal: controller.signal,
      });

      const bodyText = await res.text();
      let data: any;
      try {
        data = JSON.parse(bodyText);
      } catch {
        throw new Error(`Luna returned non-JSON response: ${bodyText.slice(0, 300)}`);
      }

      if (!res.ok) {
        const msg = data?.error?.message ?? data?.message ?? bodyText;
        throw new Error(`Luna API error (HTTP ${res.status}): ${msg}`);
      }

      const raw = data?.choices?.[0]?.message?.content;
      if (typeof raw !== 'string' || !raw.trim()) {
        throw new Error(`Luna returned empty content: ${JSON.stringify(data).slice(0, 200)}`);
      }
      content = raw.trim();
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`Luna request timed out after ${TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    return parseSignalOutput(content);
  }
}

/**
 * Parses and validates the provider's JSON output. Invalid output throws so the
 * classifier records SCORING_FAILED — never a default score.
 */
export function parseSignalOutput(raw: string): SignalScoreOutput {
  const jsonText = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`Luna signal output is not valid JSON: ${raw.slice(0, 300)}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Luna signal output must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;

  const signalScore = Number(obj.signalScore);
  if (!Number.isFinite(signalScore) || signalScore < 0 || signalScore > 100) {
    throw new Error('Luna signal output has an invalid signalScore');
  }
  const confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('Luna signal output has an invalid confidence');
  }
  const signalCategory = String(obj.signalCategory ?? '');
  if (!(SIGNAL_CATEGORIES as readonly string[]).includes(signalCategory)) {
    throw new Error(`Luna signal output has an invalid signalCategory: ${signalCategory}`);
  }
  const urgency = String(obj.urgency ?? '').toUpperCase();
  if (!['HIGH', 'MEDIUM', 'LOW'].includes(urgency)) {
    throw new Error(`Luna signal output has an invalid urgency: ${urgency}`);
  }
  const evidenceQuote = typeof obj.evidenceQuote === 'string' && obj.evidenceQuote.trim()
    ? obj.evidenceQuote.trim()
    : null;
  const whatTheyNeed = typeof obj.whatTheyNeed === 'string' && obj.whatTheyNeed.trim()
    ? obj.whatTheyNeed.trim()
    : null;

  return {
    signalScore,
    confidence,
    signalCategory: signalCategory as SignalScoreOutput['signalCategory'],
    urgency: urgency as SignalScoreOutput['urgency'],
    whatTheyNeed,
    evidenceQuote,
    reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
  };
}
