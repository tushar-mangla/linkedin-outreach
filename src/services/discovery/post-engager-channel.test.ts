import { describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../../db/memory-storage.js';
import { EngagerTargetRegistry } from './engager-target-registry.js';
import type { PostEngagerEntry, PostEngagerRunner, TargetPost } from './opencli-post-engager-runner.js';
import {
  CHANNEL5_SOURCES_LIMIT,
  CHANNEL5_SYSTEM_ACTOR,
  PostEngagerChannel,
  POST_ENGAGER_SOURCE,
  mergeChannel5SourceMetadata,
  qualifyEngager,
  type Channel5SourceMetadata,
} from './post-engager-channel.js';

const TARGET_POST: TargetPost = {
  postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7200000000000000001/',
  authorName: '',
  postText: 'Recruiters: automation is the future of sourcing pipelines and candidate engagement.',
};

const TARGET_POST_2: TargetPost = {
  postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7200000000000000002/',
  authorName: '',
  postText: 'Stop treating your recruiters like order takers. Build a real sourcing strategy.',
};

const QUALIFIED_LIKER: PostEngagerEntry = {
  profileUrl: 'https://www.linkedin.com/in/jane-recruiter',
  name: 'Jane Recruiter',
  headline: 'Founder @ Acme Recruiting',
  interaction: 'LIKE',
};

const QUALIFIED_COMMENTER: PostEngagerEntry = {
  profileUrl: 'https://www.linkedin.com/in/bob-seeker',
  name: 'Bob Seeker',
  headline: 'Recruiter @ TalentCo',
  interaction: 'COMMENT',
  commentText: 'This is a great take on sourcing automation.',
};

const INVALID_URL: PostEngagerEntry = {
  profileUrl: 'https://evil.example.com/in/not-linkedin',
  name: 'Malformed',
  interaction: 'LIKE',
};

const NO_NAME: PostEngagerEntry = {
  profileUrl: 'https://www.linkedin.com/in/nameless',
  name: '  ',
  interaction: 'LIKE',
};

function buildRunner(postsByTarget: Record<string, TargetPost[]>, engagersByPost: Record<string, PostEngagerEntry[]>) {
  const runner: PostEngagerRunner = {
    fetchRecentPosts: async (targetUrl) => postsByTarget[targetUrl] ?? [],
    fetchEngagers: async (postUrl) => engagersByPost[postUrl] ?? [],
  };
  return runner;
}

async function prepareChannel(storage: MemoryStorage, runner: PostEngagerRunner, engageProspect?: (t: string, p: string) => Promise<{ draftsCreated: number; postsFound: number }>) {
  const registry = new EngagerTargetRegistry(storage);
  await registry.seed('tenant-1');
  const channel = new PostEngagerChannel({
    runner,
    db: storage,
    registry,
    engageProspect,
    now: () => new Date('2026-09-14T00:00:00.000Z'),
  });
  const targets = await registry.list('tenant-1');
  return { channel, registry, targets };
}

describe('qualifyEngager (pure)', () => {
  it('accepts a canonical personal profile URL with a visible name', () => {
    expect(qualifyEngager(QUALIFIED_LIKER)).toEqual({ ok: true, normalizedUrl: 'https://linkedin.com/in/jane-recruiter' });
  });

  it('rejects missing names', () => {
    expect(qualifyEngager(NO_NAME).ok).toBe(false);
  });

  it('rejects non-LinkedIn and non-profile URLs', () => {
    expect(qualifyEngager(INVALID_URL).ok).toBe(false);
    expect(qualifyEngager({ profileUrl: 'https://www.linkedin.com/company/ashbyhq', name: 'Ashby', interaction: 'LIKE' }).ok).toBe(false);
    expect(qualifyEngager({ profileUrl: 'not-a-url', name: 'x', interaction: 'LIKE' }).ok).toBe(false);
    expect(qualifyEngager({ profileUrl: 'https://www.linkedin.com/in/', name: 'x', interaction: 'LIKE' }).ok).toBe(false);
  });

  it('rejects a missing profile URL entirely', () => {
    expect(qualifyEngager({ profileUrl: '', name: 'Jane', interaction: 'LIKE' }).ok).toBe(false);
  });
});

describe('mergeChannel5SourceMetadata (pure, bounded)', () => {
  const source: Channel5SourceMetadata = {
    name: 'Jane Recruiter',
    source: POST_ENGAGER_SOURCE,
    sourceTarget: 'Greg Savage',
    sourceTargetType: 'INFLUENCER',
    sourceTargetUrl: 'https://www.linkedin.com/in/gregsavage/',
    sourcePostUrl: TARGET_POST.postUrl,
    sourceInteraction: 'LIKE',
    sourceObservedAt: '2026-09-14T00:00:00.000Z',
  };

  it('builds the full Channel 5 contract for a new prospect', () => {
    const merged = mergeChannel5SourceMetadata(undefined, { ...source, title: 'Founder @ Acme' });
    expect(merged.source).toBe(POST_ENGAGER_SOURCE);
    expect(merged.sourceTarget).toBe('Greg Savage');
    expect(merged.sourceInteraction).toBe('LIKE');
    expect(merged.name).toBe('Jane Recruiter');
    expect(merged.title).toBe('Founder @ Acme');
    expect((merged.channel5Sources as unknown[])).toHaveLength(1);
    expect((merged.channel5Sources as Channel5SourceMetadata[])[0]).toMatchObject({ sourceTarget: 'Greg Savage', sourcePostUrl: TARGET_POST.postUrl });
  });

  it('preserves curated name/title and a different channel source while appending evidence', () => {
    const existing = { name: 'Jane Curated', title: 'CEO', source: 'POST_KEYWORD_SEARCH', sourceQuery: 'manual sourcing', channel5Sources: [] };
    const merged = mergeChannel5SourceMetadata(existing, source);
    expect(merged.name).toBe('Jane Curated');
    expect(merged.title).toBe('CEO');
    expect(merged.source).toBe('POST_KEYWORD_SEARCH');
    expect(merged.channel5Sources).toHaveLength(1);
  });

  it('keeps first Channel 5 source fields across extractions', () => {
    const first = mergeChannel5SourceMetadata(undefined, source);
    const secondSource: Channel5SourceMetadata = { ...source, sourceTarget: 'Hung Lee', sourcePostUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:9/' };
    const merged = mergeChannel5SourceMetadata(first, secondSource);
    expect(merged.sourceTarget).toBe('Greg Savage');
    expect(merged.sourcePostUrl).toBe(TARGET_POST.postUrl);
    expect((merged.channel5Sources as unknown[])).toHaveLength(2);
  });

  it('truncates the evidence list at CHANNEL5_SOURCES_LIMIT', () => {
    let current = mergeChannel5SourceMetadata(undefined, source);
    for (let i = 0; i < CHANNEL5_SOURCES_LIMIT + 3; i++) {
      current = mergeChannel5SourceMetadata(current, { ...source, sourcePostUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${i}/` });
    }
    expect(Array.isArray(current.channel5Sources)).toBe(true);
    expect((current.channel5Sources as unknown[]).length).toBe(CHANNEL5_SOURCES_LIMIT);
    const firstEvidence = (current.channel5Sources as Array<{ sourcePostUrl: string }>)[0];
    expect(firstEvidence.sourcePostUrl).not.toBe(TARGET_POST.postUrl); // oldest dropped
  });
});

describe('PostEngagerChannel (offline, MemoryStorage + fake runner)', () => {
  it('sources qualified engagers, persists Channel 5 metadata, and never writes scheduled actions directly', async () => {
    const storage = new MemoryStorage();
    const engageProspect = vi.fn(async () => ({ draftsCreated: 1, postsFound: 1 }));
    const { channel, targets } = await prepareChannel(storage, buildRunner(
      { 'https://www.linkedin.com/in/gregsavage/': [TARGET_POST, TARGET_POST_2] },
      { [TARGET_POST.postUrl]: [QUALIFIED_LIKER, QUALIFIED_COMMENTER, INVALID_URL, NO_NAME] },
    ), engageProspect);

    const result = await channel.run('tenant-1', { targetIds: [targets[4].id] }); // Greg Savage influencer

    expect(result.counts.posts).toBe(2);
    expect(result.counts.engagers).toBe(4);
    expect(result.counts.qualified).toBe(2);
    expect(result.counts.duplicates).toBe(0);
    expect(result.counts.filtered).toBe(2);
    expect(result.counts.draftCreated).toBe(2);

    const prospects = storage.getTable('prospects');
    expect(prospects).toHaveLength(2);
    for (const p of prospects) {
      expect(p.currentStage).toBe('READY_FOR_CAMPAIGN');
      expect(p.customAttributes.source).toBe(POST_ENGAGER_SOURCE);
      expect(p.customAttributes.sourceTarget).toBe('Greg Savage');
      expect(p.customAttributes.sourceTargetType).toBe('INFLUENCER');
      expect(p.customAttributes.sourcePostUrl).toBe(TARGET_POST.postUrl);
      expect(p.customAttributes.sourceObservedAt).toBe('2026-09-14T00:00:00.000Z');
      expect(p.customAttributes.channel5Sources).toHaveLength(1);
    }
    const jane = prospects.find(p => p.customAttributes.name === 'Jane Recruiter')!;
    expect(jane.customAttributes.sourceInteraction).toBe('LIKE');
    const bob = prospects.find(p => p.customAttributes.name === 'Bob Seeker')!;
    expect(bob.customAttributes.sourceInteraction).toBe('COMMENT');
    expect(bob.customAttributes.sourceCommentText).toBe('This is a great take on sourcing automation.');

    // System actor review decision + audit event for each new prospect.
    const decisions = storage.getTable('reviewDecisions');
    expect(decisions).toHaveLength(2);
    expect(decisions.every(d => d.operatorId === CHANNEL5_SYSTEM_ACTOR && d.decision === 'APPROVED')).toBe(true);
    const audits = storage.getTable('auditEvents');
    expect(audits.filter(a => a.eventType === 'prospect.ready_for_campaign').length).toBe(2);
    expect(audits.every(a => (a.payload as { actor?: string }).actor === CHANNEL5_SYSTEM_ACTOR)).toBe(true);

    // Warm-up hook invoked for each ready prospect.
    expect(engageProspect).toHaveBeenCalledTimes(2);

    // Regression: Channel 5 never directly inserts scheduled actions.
    expect(storage.getTable('scheduledActions')).toHaveLength(0);
    expect(result.status).toBe('completed');
  });

  it('reports no-eligible-prospect-post when the scan finds nothing', async () => {
    const storage = new MemoryStorage();
    const { channel, targets } = await prepareChannel(storage, buildRunner(
      { 'https://www.linkedin.com/in/gregsavage/': [TARGET_POST] },
      { [TARGET_POST.postUrl]: [QUALIFIED_LIKER] },
    ), async () => ({ draftsCreated: 0, postsFound: 0 }));

    const result = await channel.run('tenant-1', { targetIds: [targets[4].id] });

    expect(result.counts.qualified).toBe(1);
    expect(result.counts.draftCreated).toBe(0);
    expect(result.counts.noEligibleProspectPost).toBe(1);
    expect(result.prospects[0].outcome).toBe('no-eligible-prospect-post');
    expect(result.prospects[0].stage).toBe('READY_FOR_CAMPAIGN');
  });

  it('dedupes existing prospects and preserves their stage and curated data', async () => {
    const storage = new MemoryStorage();
    const existing = await storage.insertProspect({
      tenantId: 'tenant-1',
      linkedinUrl: 'https://www.linkedin.com/in/jane-recruiter',
      normalizedLinkedinUrl: 'https://linkedin.com/in/jane-recruiter',
      customAttributes: { name: 'Jane Curated', source: 'POST_KEYWORD_SEARCH', channel5Sources: [] },
    });
    await storage.updateProspectStage(existing.id, 'EVALUATED');
    const { channel, targets } = await prepareChannel(storage, buildRunner(
      { 'https://www.linkedin.com/in/gregsavage/': [TARGET_POST] },
      { [TARGET_POST.postUrl]: [QUALIFIED_LIKER] },
    ), async () => ({ draftsCreated: 0, postsFound: 0 }));

    const result = await channel.run('tenant-1', { targetIds: [targets[4].id] });

    expect(result.counts.duplicates).toBe(1);
    expect(result.counts.qualified).toBe(0);
    const [prospectRow] = storage.getTable('prospects');
    // Stage preserved: no forced promotion of a foreign-channel prospect.
    expect(prospectRow.currentStage).toBe('EVALUATED');
    expect(prospectRow.customAttributes.name).toBe('Jane Curated');
    expect(prospectRow.customAttributes.source).toBe('POST_KEYWORD_SEARCH');
    // Bounded evidence appended.
    expect(prospectRow.customAttributes.channel5Sources).toHaveLength(1);
    expect(result.prospects[0].outcome).toBe('duplicate');
  });

  it('scans existing campaign-ready prospects and reports draft-created', async () => {
    const storage = new MemoryStorage();
    const existing = await storage.insertProspect({
      tenantId: 'tenant-1',
      linkedinUrl: 'https://www.linkedin.com/in/jane-recruiter',
      normalizedLinkedinUrl: 'https://linkedin.com/in/jane-recruiter',
      customAttributes: { name: 'Jane Recruiter' },
    });
    await storage.updateProspectStage(existing.id, 'READY_FOR_CAMPAIGN');
    const { channel, targets } = await prepareChannel(storage, buildRunner(
      { 'https://www.linkedin.com/in/gregsavage/': [TARGET_POST] },
      { [TARGET_POST.postUrl]: [QUALIFIED_LIKER] },
    ), async () => ({ draftsCreated: 2, postsFound: 1 }));

    const result = await channel.run('tenant-1', { targetIds: [targets[4].id] });

    expect(result.counts.duplicates).toBe(1);
    expect(result.counts.draftCreated).toBe(1);
    expect(result.prospects[0].outcome).toBe('draft-created');
    expect(result.prospects[0].stage).toBe('READY_FOR_CAMPAIGN');
  });

  it('throws NO_ACTIVE_TARGETS for an empty active set', async () => {
    const storage = new MemoryStorage();
    const { channel, targets } = await prepareChannel(storage, buildRunner({}, {}));
    for (const t of targets) await new EngagerTargetRegistry(storage).setActive('tenant-1', t.id, false);

    await expect(channel.run('tenant-1', {})).rejects.toThrow('NO_ACTIVE_TARGETS');
    // Explicit empty selection also yields NO_ACTIVE_TARGETS.
    await expect(channel.run('tenant-1', { targetIds: [] })).rejects.toThrow('NO_ACTIVE_TARGETS');
  });

  it('rejects inactive and unknown target ids', async () => {
    const storage = new MemoryStorage();
    const { channel, targets } = await prepareChannel(storage, buildRunner({}, {}));
    const registry = new EngagerTargetRegistry(storage);
    await registry.setActive('tenant-1', targets[0].id, false);

    await expect(channel.run('tenant-1', { targetIds: [targets[0].id] })).rejects.toThrow('TARGET_NOT_ACTIVE');
    await expect(channel.run('tenant-1', { targetIds: ['does-not-exist'] })).rejects.toThrow('TARGET_NOT_FOUND');
  });

  it('returns partial results with sanitized per-target errors on extraction failure', async () => {
    const storage = new MemoryStorage();
    const runner: PostEngagerRunner = {
      fetchRecentPosts: async (url) => {
        if (url.includes('gregsavage')) throw new Error('OPENCLI_NO_PAGE_TARGET');
        return [TARGET_POST];
      },
      fetchEngagers: async () => [QUALIFIED_LIKER],
    };
    const { channel, targets } = await prepareChannel(storage, runner, async () => ({ draftsCreated: 0, postsFound: 0 }));
    const greg = targets.find(t => t.displayName === 'Greg Savage')!;
    const hung = targets.find(t => t.displayName === 'Hung Lee')!;

    const result = await channel.run('tenant-1', { targetIds: [greg.id, hung.id] });

    expect(result.status).toBe('partial');
    const gregTarget = result.targets.find(t => t.targetId === greg.id)!;
    expect(gregTarget.error).toBe('OPENCLI_NO_PAGE_TARGET');
    expect(gregTarget.postsFound).toBe(0);
    const hungTarget = result.targets.find(t => t.targetId === hung.id)!;
    expect(hungTarget.error).toBeNull();
    expect(result.counts.qualified).toBe(1);
    // No raw DOM/session data leaks into the result; only typed target rows.
    expect(result.targets.every(t => typeof t.error === 'string' || t.error === null)).toBe(true);
  });

  it('respects maxPostsPerTarget and maxEngagersPerPost caps', async () => {
    const storage = new MemoryStorage();
    const posts = Array.from({ length: 5 }, (_, i) => ({ ...TARGET_POST, postUrl: `https://www.linkedin.com/feed/update/urn:li:activity:72${i}0000000000${i + 1}/` }));
    // Unique engagers per post so cap behavior is observable without dedupe noise.
    const engagersByPost = Object.fromEntries(posts.map((p, postIndex) => [
      p.postUrl,
      Array.from({ length: 5 }, (_, i) => ({ ...QUALIFIED_LIKER, name: `Engager ${postIndex}-${i}`, profileUrl: `https://www.linkedin.com/in/engager-${postIndex}-${i}` })),
    ]));
    const { channel, targets } = await prepareChannel(storage, buildRunner(
      { 'https://www.linkedin.com/in/gregsavage/': posts },
      engagersByPost,
    ), async () => ({ draftsCreated: 0, postsFound: 0 }));

    const result = await channel.run('tenant-1', { targetIds: [targets[4].id], maxPostsPerTarget: 2, maxEngagersPerPost: 2 });

    expect(result.counts.posts).toBe(2);
    expect(result.counts.engagers).toBe(4);
    expect(result.counts.qualified).toBe(4);
  });

  it('returns a completed-empty run for a target with no posts or engagers', async () => {
    const storage = new MemoryStorage();
    const { channel, targets } = await prepareChannel(storage, buildRunner({}, {}));
    const result = await channel.run('tenant-1', { targetIds: [targets[4].id] });
    expect(result.status).toBe('completed');
    expect(result.counts).toMatchObject({ posts: 0, engagers: 0, qualified: 0, duplicates: 0, filtered: 0 });
    expect(result.prospects).toEqual([]);
  });

  it('dedupes the same engager across multiple posts in a single run using seenProspectUrls', async () => {
    const storage = new MemoryStorage();
    const engageProspect = vi.fn(async () => ({ draftsCreated: 1, postsFound: 1 }));
    const { channel, targets } = await prepareChannel(storage, buildRunner(
      { 'https://www.linkedin.com/in/gregsavage/': [TARGET_POST, TARGET_POST_2] },
      {
        [TARGET_POST.postUrl]: [QUALIFIED_LIKER],
        [TARGET_POST_2.postUrl]: [QUALIFIED_LIKER], // same engager on post 2
      },
    ), engageProspect);

    const result = await channel.run('tenant-1', { targetIds: [targets[4].id] });

    expect(result.counts.posts).toBe(2);
    expect(result.counts.engagers).toBe(2);
    expect(result.counts.qualified).toBe(1);
    expect(result.counts.duplicates).toBe(1);
    expect(result.counts.noEligibleProspectPost).toBe(0);
    expect(result.counts.draftCreated).toBe(1);
    // engageProspect called only once for Jane
    expect(engageProspect).toHaveBeenCalledTimes(1);
    expect(result.prospects).toHaveLength(1);
    expect(result.prospects[0].outcome).toBe('draft-created');
  });

  it('records existing campaign-ready prospects with existing drafts as draft-created (reused) instead of no-eligible-prospect-post', async () => {
    const storage = new MemoryStorage();
    const existing = await storage.insertProspect({
      tenantId: 'tenant-1',
      linkedinUrl: 'https://www.linkedin.com/in/jane-recruiter',
      normalizedLinkedinUrl: 'https://linkedin.com/in/jane-recruiter',
      customAttributes: { name: 'Jane Recruiter' },
    });
    await storage.updateProspectStage(existing.id, 'READY_FOR_CAMPAIGN');
    const { channel, targets } = await prepareChannel(storage, buildRunner(
      { 'https://www.linkedin.com/in/gregsavage/': [TARGET_POST] },
      { [TARGET_POST.postUrl]: [QUALIFIED_LIKER] },
    ), async () => ({ draftsCreated: 0, postsFound: 1, existingDrafts: 2 }));

    const result = await channel.run('tenant-1', { targetIds: [targets[4].id] });

    expect(result.counts.duplicates).toBe(1);
    expect(result.counts.draftCreated).toBe(1);
    expect(result.counts.noEligibleProspectPost).toBe(0);
    expect(result.prospects[0].outcome).toBe('draft-created');
    expect(result.prospects[0].draftCount).toBe(2);
  });

  it('records existing campaign-ready prospects with already scheduled actions as duplicate instead of no-eligible-prospect-post', async () => {
    const storage = new MemoryStorage();
    const existing = await storage.insertProspect({
      tenantId: 'tenant-1',
      linkedinUrl: 'https://www.linkedin.com/in/jane-recruiter',
      normalizedLinkedinUrl: 'https://linkedin.com/in/jane-recruiter',
      customAttributes: { name: 'Jane Recruiter' },
    });
    await storage.updateProspectStage(existing.id, 'READY_FOR_CAMPAIGN');
    const { channel, targets } = await prepareChannel(storage, buildRunner(
      { 'https://www.linkedin.com/in/gregsavage/': [TARGET_POST] },
      { [TARGET_POST.postUrl]: [QUALIFIED_LIKER] },
    ), async () => ({ draftsCreated: 0, postsFound: 1, alreadyScheduled: true }));

    const result = await channel.run('tenant-1', { targetIds: [targets[4].id] });

    expect(result.counts.duplicates).toBe(1);
    expect(result.counts.draftCreated).toBe(0);
    expect(result.counts.noEligibleProspectPost).toBe(0);
    expect(result.prospects[0].outcome).toBe('duplicate');
  });

  it('passes recency option to fetchRecentPosts', async () => {
    const storage = new MemoryStorage();
    const fetchRecentPosts = vi.fn(async (_url: string, _recency?: any) => [TARGET_POST]);
    const runner: PostEngagerRunner = {
      fetchRecentPosts,
      fetchEngagers: async () => [],
    };
    const { channel, targets } = await prepareChannel(storage, runner);

    await channel.run('tenant-1', { targetIds: [targets[4].id], recency: 'past-24h' });

    expect(fetchRecentPosts).toHaveBeenCalledWith(targets[4].linkedinUrl, 'past-24h');
  });

  it('throws NO_ACTIVE_TARGETS when targetIds is an empty array even if active targets exist', async () => {
    const storage = new MemoryStorage();
    const { channel } = await prepareChannel(storage, buildRunner({}, {}));
    // All 11 seeded targets are active in DB, but passing explicit empty selection should reject
    await expect(channel.run('tenant-1', { targetIds: [] })).rejects.toThrow('NO_ACTIVE_TARGETS');
  });

  it('isolates errors per engager so a failure on one engager does not abort remaining engagers on the post', async () => {
    const storage = new MemoryStorage();
    const originalFind = storage.findProspectByTenantAndUrl.bind(storage);
    let callCount = 0;
    vi.spyOn(storage, 'findProspectByTenantAndUrl').mockImplementation(async (tenantId, url) => {
      callCount++;
      if (url.includes('jane-recruiter')) {
        throw new Error('SIMULATED_DB_ENGAGER_ERROR');
      }
      return originalFind(tenantId, url);
    });

    const { channel, targets } = await prepareChannel(storage, buildRunner(
      { 'https://www.linkedin.com/in/gregsavage/': [TARGET_POST] },
      { [TARGET_POST.postUrl]: [QUALIFIED_LIKER, QUALIFIED_COMMENTER] },
    ), async () => ({ draftsCreated: 1, postsFound: 1 }));

    const result = await channel.run('tenant-1', { targetIds: [targets[4].id] });

    expect(result.status).toBe('partial');
    const targetResult = result.targets[0];
    expect(targetResult.error).toBe('SIMULATED_DB_ENGAGER_ERROR');
    // Bob should still have been processed successfully
    expect(result.counts.qualified).toBe(1);
    expect(result.counts.draftCreated).toBe(1);
    expect(result.prospects).toHaveLength(1);
    expect(result.prospects[0].name).toBe('Bob Seeker');
  });
});