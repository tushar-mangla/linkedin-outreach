import { describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../../db/memory-storage.js';
import { BuyingSignalClassifier, FakeBuyingSignalProvider } from './buying-signal-classifier.js';
import {
  ContentSearchChannel,
  type ContentSearchPost,
  type ContentSearchRunner,
} from './content-search-channel.js';
import { promoteProspect } from './promotion-service.js';

const QUALIFIED_POST: ContentSearchPost = {
  postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/',
  postText: 'Manual sourcing is killing our margins this quarter. We need a better pipeline.',
  authorName: 'Jane Doe',
  authorProfileUrl: 'https://www.linkedin.com/in/jane-doe',
  authorCompany: 'Acme Recruitment',
};

const JOB_SEEKER_POST: ContentSearchPost = {
  postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000002/',
  postText: 'I am #OpenToWork and looking for my next role.',
  authorName: 'Bob Seeker',
  authorProfileUrl: 'https://www.linkedin.com/in/bob-seeker',
};

function buildChannel(storage: MemoryStorage, posts: ContentSearchPost[], generateDrafts?: (tenantId: string, prospectId: string, postId: string) => Promise<void>) {
  const runner: ContentSearchRunner = { search: async () => posts };
  return new ContentSearchChannel({
    runner,
    classifier: new BuyingSignalClassifier(new FakeBuyingSignalProvider()),
    db: storage,
    generateDrafts,
  });
}

describe('ContentSearchChannel (offline)', () => {
  it('persists qualified posts as signals, insights, prospects, and engagement posts', async () => {
    const storage = new MemoryStorage();
    const generateDrafts = vi.fn(async () => {});
    const channel = buildChannel(storage, [QUALIFIED_POST, JOB_SEEKER_POST], generateDrafts);

    const result = await channel.run('tenant-1', {
      queries: ['manual sourcing fatigue'],
      recency: 'past-24h',
      archetype: 'AGENCY_LEADERSHIP',
    });

    expect(result.postsFound).toBe(2);
    expect(result.qualified).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.queries).toEqual(['manual sourcing fatigue']);

    // Prospect created with EVALUATED stage (never auto-promoted)
    const prospects = storage.getTable('prospects');
    expect(prospects).toHaveLength(1);
    expect(prospects[0].customAttributes.name).toBe('Jane Doe');
    expect(prospects[0].currentStage).toBe('EVALUATED');

    // Buying signal persisted (dual persistence #1)
    const signals = await storage.findBuyingSignalsByTenant('tenant-1');
    expect(signals).toHaveLength(1);
    expect(signals[0].signalScore).toBeGreaterThanOrEqual(70);
    expect(signals[0].prospectId).toBe(prospects[0].id);
    expect(signals[0].archetype).toBe('AGENCY_LEADERSHIP');

    // Market content insight persisted (dual persistence #2)
    const insights = await storage.findContentInsightsByTenant('tenant-1');
    expect(insights).toHaveLength(1);
    expect(insights[0].rawVerbatimQuote).toBeTruthy();
    expect(insights[0].authorProfileUrl).toBe(QUALIFIED_POST.authorProfileUrl);

    // Engagement post ingested with the channel source type
    const posts = storage.getTable('engagementPosts');
    expect(posts).toHaveLength(1);
    expect(posts[0].sourceType).toBe('POST_KEYWORD_SEARCH');
    expect(posts[0].postText).toBe(QUALIFIED_POST.postText);

    // Draft generation triggered
    expect(generateDrafts).toHaveBeenCalledTimes(1);

    // Query stats updated
    const stats = await storage.findQueryStatsByTenant('tenant-1');
    expect(stats).toHaveLength(1);
    expect(stats[0].query).toBe('manual sourcing fatigue');
    expect(stats[0].postsFound).toBe(2);
    expect(stats[0].signalsDetected).toBe(1);
  });

  it('does not persist rejected posts', async () => {
    const storage = new MemoryStorage();
    const channel = buildChannel(storage, [JOB_SEEKER_POST]);

    const result = await channel.run('tenant-1', {
      queries: ['open to work'],
      archetype: 'AGENCY_LEADERSHIP',
    });

    expect(result.qualified).toBe(0);
    expect(storage.getTable('prospects')).toHaveLength(0);
    expect(storage.getTable('engagementPosts')).toHaveLength(0);
    expect(await storage.findBuyingSignalsByTenant('tenant-1')).toHaveLength(0);
    expect(await storage.findContentInsightsByTenant('tenant-1')).toHaveLength(0);
  });

  it('upserts an existing prospect instead of duplicating', async () => {
    const storage = new MemoryStorage();
    const existing = await storage.insertProspect({
      tenantId: 'tenant-1',
      linkedinUrl: 'https://www.linkedin.com/in/jane-doe',
      normalizedLinkedinUrl: 'https://linkedin.com/in/jane-doe',
      customAttributes: { name: 'Jane Doe' },
    });
    const channel = buildChannel(storage, [QUALIFIED_POST]);

    await channel.run('tenant-1', { queries: ['manual sourcing'], archetype: 'AGENCY_LEADERSHIP' });

    expect(storage.getTable('prospects')).toHaveLength(1);
    expect(storage.getTable('prospects')[0].id).toBe(existing.id);
  });

  it('accumulates query stats across runs', async () => {
    const storage = new MemoryStorage();
    const channel = buildChannel(storage, [QUALIFIED_POST]);

    await channel.run('tenant-1', { queries: ['manual sourcing fatigue'], archetype: 'AGENCY_LEADERSHIP' });
    await channel.run('tenant-1', { queries: ['manual sourcing fatigue'], archetype: 'AGENCY_LEADERSHIP' });

    const stats = await storage.findQueryStatsByTenant('tenant-1');
    expect(stats).toHaveLength(1);
    expect(stats[0].postsFound).toBe(2);
    expect(stats[0].signalsDetected).toBe(2);
  });
});

describe('promoteProspect (operator gate)', () => {
  it('promotes a prospect to READY_FOR_CAMPAIGN and attributes the query stat', async () => {
    const storage = new MemoryStorage();
    const channel = buildChannel(storage, [QUALIFIED_POST]);
    await channel.run('tenant-1', { queries: ['manual sourcing fatigue'], archetype: 'AGENCY_LEADERSHIP' });
    const prospect = storage.getTable('prospects')[0];
    expect(prospect.currentStage).toBe('EVALUATED');

    const result = await promoteProspect(storage, 'tenant-1', prospect.id, 'operator-1', 'Strong signal');

    expect(result).toEqual({ prospectId: prospect.id, currentStage: 'READY_FOR_CAMPAIGN' });
    expect(storage.getTable('prospects')[0].currentStage).toBe('READY_FOR_CAMPAIGN');

    // Review decision + audit event written
    expect(storage.getTable('reviewDecisions')).toHaveLength(1);
    expect(storage.getTable('reviewDecisions')[0].decision).toBe('APPROVED');
    expect(storage.getTable('auditEvents').some((e) => e.eventType === 'prospect.ready_for_campaign')).toBe(true);

    // Query stat attributed via the prospect's sourceQuery
    const stats = await storage.findQueryStatsByTenant('tenant-1');
    expect(stats[0].prospectsPromoted).toBe(1);
  });

  it('throws PROSPECT_NOT_FOUND for an unknown prospect', async () => {
    const storage = new MemoryStorage();
    await expect(promoteProspect(storage, 'tenant-1', 'missing-id', 'operator-1')).rejects.toThrow('PROSPECT_NOT_FOUND');
  });
});