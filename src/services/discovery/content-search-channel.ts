import type { DBAdapter } from '../../db/db-adapter.js';
import type { ProspectArchetype, ProspectBuyingSignalCategory, ProspectStage } from '../../types.js';
import { normalizeLinkedinUrl } from '../icp/url-normalizer.js';
import { canonicalPostIdentifier } from '../engagement/post-identity.js';
import { hashPostContent } from '../engagement/prospect-post-source.js';
import { BuyingSignalClassifier } from './buying-signal-classifier.js';
import {
  getContentSearchQueryPresets,
  type DatePostedWindow,
} from './content-search-queries.js';

export interface ContentSearchPost {
  postUrl: string;
  postText: string;
  authorName: string;
  authorProfileUrl: string;
  authorCompany?: string;
  publishedAt?: Date;
}

/** Pluggable seam for the LinkedIn content-search page (OpenCLI in production, fixtures in tests). */
export interface ContentSearchRunner {
  search(query: string, recency: DatePostedWindow): Promise<ContentSearchPost[]>;
}

export interface ContentSearchChannelDeps {
  runner: ContentSearchRunner;
  classifier: BuyingSignalClassifier;
  db: DBAdapter;
  /** Draft-generation hook, wired to the engagement service in production. */
  generateDrafts?: (tenantId: string, prospectId: string, postId: string) => Promise<void>;
}

export interface ContentSearchRunOptions {
  queries?: string[];
  recency?: DatePostedWindow;
  archetype?: ProspectArchetype;
  maxPostsPerQuery?: number;
}

export interface QualifiedProspectResult {
  prospectId: string;
  name: string;
  linkedinUrl: string;
  stage: ProspectStage;
  signalScore: number;
  signalCategory: ProspectBuyingSignalCategory;
  evidenceQuote: string | null;
  postUrl: string;
}

export interface ContentSearchRunResult {
  queries: string[];
  recency: DatePostedWindow;
  archetype: ProspectArchetype;
  postsFound: number;
  signalsDetected: number;
  qualified: number;
  rejected: number;
  prospects: QualifiedProspectResult[];
}

/**
 * Channel 4 — post keyword search with AI buying signals.
 *
 * Flow per query: search posts -> hybrid classifier (negative gate -> regex
 * extraction -> LLM with verbatim grounding) -> qualified posts persist a
 * buying signal, a market content insight, a prospect (upsert), the post in
 * engagement_posts, and trigger draft generation. Query stats are upserted per
 * query so zero-yield queries stay visible.
 *
 * No auto-promotion: qualified prospects land at EVALUATED and only an explicit
 * operator promotion (POST /api/prospects/:id/promote) sets READY_FOR_CAMPAIGN.
 */
export class ContentSearchChannel {
  private readonly deps: ContentSearchChannelDeps;

  constructor(deps: ContentSearchChannelDeps) {
    this.deps = deps;
  }

  async run(tenantId: string, options: ContentSearchRunOptions = {}): Promise<ContentSearchRunResult> {
    const queries = options.queries && options.queries.length > 0 ? options.queries : getContentSearchQueryPresets();
    const recency = options.recency ?? 'past-24h';
    const archetype = options.archetype ?? 'AGENCY_LEADERSHIP';
    const maxPostsPerQuery = Math.min(Math.max(options.maxPostsPerQuery ?? 25, 1), 25);

    const prospects: QualifiedProspectResult[] = [];
    let postsFound = 0;
    let signalsDetected = 0;
    let rejected = 0;

    for (const query of queries) {
      const posts = await this.deps.runner.search(query, recency);
      postsFound += posts.length;
      let querySignals = 0;

      for (const post of posts.slice(0, maxPostsPerQuery)) {
        const classification = await this.deps.classifier.classify({
          postText: post.postText,
          authorName: post.authorName,
          authorCompany: post.authorCompany,
          archetype,
        });

        if (!classification.passed || classification.status !== 'QUALIFIED') {
          rejected += 1;
          continue;
        }

        // Upsert prospect by canonical profile URL.
        const normalizedUrl = normalizeLinkedinUrl(post.authorProfileUrl);
        let prospect = await this.deps.db.findProspectByTenantAndUrl(tenantId, normalizedUrl);
        if (!prospect) {
          prospect = await this.deps.db.insertProspect({
            tenantId,
            linkedinUrl: post.authorProfileUrl,
            normalizedLinkedinUrl: normalizedUrl,
            customAttributes: {
              name: post.authorName,
              company: post.authorCompany ?? '',
              source: 'POST_KEYWORD_SEARCH',
              sourceQuery: query,
              archetype,
            },
          });
        }
        // New prospects land at EVALUATED; existing prospects keep their stage.
        if (prospect.currentStage === 'INGESTED') {
          await this.deps.db.updateProspectStage(prospect.id, 'EVALUATED');
          prospect = { ...prospect, currentStage: 'EVALUATED' };
        }

        // Ingest the post into engagement_posts (deduped on canonical identifier).
        const postRecord = await this.deps.db.insertEngagementPost({
          tenantId,
          prospectId: prospect.id,
          postUrl: post.postUrl,
          canonicalPostIdentifier: canonicalPostIdentifier(post.postUrl),
          postText: post.postText,
          authorName: post.authorName,
          publishedAt: post.publishedAt,
          sourceType: 'POST_KEYWORD_SEARCH',
          contentHash: hashPostContent(post.postText),
        });

        // Persist the buying signal.
        await this.deps.db.insertProspectBuyingSignal({
          tenantId,
          prospectId: prospect.id,
          postId: postRecord.id,
          archetype,
          signalCategory: classification.signalCategory,
          signalScore: classification.signalScore,
          urgency: classification.urgency,
          extractedEmails: classification.extractedEmails.length > 0 ? classification.extractedEmails : null,
          extractedLinks: classification.extractedLinks.length > 0 ? classification.extractedLinks : null,
          whatTheyNeed: classification.whatTheyNeed,
          evidenceQuote: classification.evidenceQuote,
        });

        // Persist the market content insight (dual intelligence vault).
        await this.deps.db.insertMarketContentInsight({
          tenantId,
          sourcePostId: postRecord.id,
          authorProfileUrl: post.authorProfileUrl,
          category: classification.signalCategory,
          rawVerbatimQuote: classification.evidenceQuote ?? post.postText.slice(0, 200),
          emotionalSentiment: classification.urgency,
          suggestedContentHook: classification.whatTheyNeed,
          toolsMentioned: [],
        });

        // Trigger draft generation through the engagement path.
        if (this.deps.generateDrafts) {
          await this.deps.generateDrafts(tenantId, prospect.id, postRecord.id);
        }

        querySignals += 1;
        signalsDetected += 1;
        prospects.push({
          prospectId: prospect.id,
          name: post.authorName,
          linkedinUrl: post.authorProfileUrl,
          stage: prospect.currentStage,
          signalScore: classification.signalScore,
          signalCategory: classification.signalCategory,
          evidenceQuote: classification.evidenceQuote,
          postUrl: post.postUrl,
        });
      }

      // Closed-loop query stats: upsert per (tenant, query).
      await this.deps.db.upsertDiscoveryQueryStat({
        tenantId,
        query,
        postsFound: posts.length,
        signalsDetected: querySignals,
      });
    }

    return {
      queries,
      recency,
      archetype,
      postsFound,
      signalsDetected,
      qualified: signalsDetected,
      rejected,
      prospects,
    };
  }
}