import type { CommentDraft } from '../../types.js';
import type { EngagementAIProvider, GenerateCommentInput } from './engagement-ai-provider.js';

// ─── LunaEngagementProvider ───────────────────────────────────────────────────
//
// Uses the codex-everywhere OpenAI-compatible HTTP API with the gpt-5.6-luna model
// to generate contextual, grounded LinkedIn comment drafts.
//
// Required env vars:
//   CODEX_EVERYWHERE_API_KEY  — API key for codex-everywhere
//   CODEX_EVERYWHERE_BASE_URL — Base URL (default: https://api.codex-everywhere.com/v1)

const DEFAULT_BASE_URL = 'https://api.codex-everywhere.com/v1';
const MODEL = 'gpt-5.6-luna';
const TIMEOUT_MS = 30_000;

export class LunaEngagementProvider implements EngagementAIProvider {
  readonly providerName = 'luna' as const;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts?: { apiKey?: string; baseUrl?: string }) {
    this.apiKey = opts?.apiKey ?? process.env.CODEX_EVERYWHERE_API_KEY ?? '';
    this.baseUrl = opts?.baseUrl ?? process.env.CODEX_EVERYWHERE_BASE_URL ?? DEFAULT_BASE_URL;

    if (!this.apiKey) {
      throw new Error(
        'LunaEngagementProvider: CODEX_EVERYWHERE_API_KEY is not set. ' +
        'Add it to your .env file.',
      );
    }
  }

  async generateComment(input: GenerateCommentInput): Promise<CommentDraft> {
    const { postText, authorName, voiceProfile } = input;

    const systemPrompt = [
      'You are a thoughtful recruiter writing a genuine LinkedIn comment.',
      'Your goal is to engage authentically with the author\'s post — not to sell or pitch.',
      'Rules:',
      '- Write between 20 and 45 words.',
      '- Reference a SPECIFIC detail from the post text.',
      '- Do NOT use generic openers like "Great post!", "Congrats!", "Love this!", "Insightful!", or "Totally agree!".',
      '- Do NOT mention that you are a recruiter.',
      '- Sound like a thoughtful peer, not a marketer.',
      ...(voiceProfile ? [`Your voice profile: ${voiceProfile}`] : []),
    ].join('\n');

    const userPrompt = [
      `Author: ${authorName}`,
      '',
      'Post text:',
      '"""',
      postText,
      '"""',
      '',
      'Write a single LinkedIn comment. Output ONLY the comment text, no labels, no quotes.',
    ].join('\n');

    const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let commentText: string;

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.75,
          max_tokens: 120,
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

      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error(`Luna returned empty content: ${JSON.stringify(data).slice(0, 200)}`);
      }

      commentText = content.trim();
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`Luna request timed out after ${TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    // Extract a brief grounding evidence snippet from the post text
    const firstSentence = postText.split(/[.!?]/)[0]?.trim() ?? postText.slice(0, 80);

    return {
      commentText,
      groundingEvidence: firstSentence,
      providerMeta: { model: MODEL, provider: 'codex-everywhere' },
    };
  }
}
