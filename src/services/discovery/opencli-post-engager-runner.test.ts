import { describe, expect, it } from 'vitest';
import {
  OpenCliPostEngagerRunner,
  isWithinRecency,
  parsePostEngagersMarkdown,
  parseRelativeTimeHours,
  parseTargetProfileMarkdown,
  toActivityFeedUrl,
  type PostEngagerEntry,
  type PostRecency,
  type TargetPost,
} from './opencli-post-engager-runner.js';

const PROFILE_FEED_FIXTURE = `
## Greg Savage | LinkedIn · Activity

[Greg Savage](https://www.linkedin.com/in/gregsavage)
[Retail recruiters, stop treating your candidates like widgets.](https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/)
2d ago

[Hung Lee](https://www.linkedin.com/in/hunglee)
[The best sourcing metric is not cost per hire.](https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000002/)
1d ago
`;

const COMPANY_POSTS_FIXTURE = `
## Bullhorn | LinkedIn · Posts

[Bullhorn](https://www.linkedin.com/company/bullhorn/)
[Bullhorn announces new recruitment AI platform. Learn how it accelerates sourcing pipelines.](https://www.linkedin.com/posts/bullhorn_recruitment-ai-activity-7200000000000000001/)
3d ago

[Bullhorn](https://www.linkedin.com/company/bullhorn/)
[Join us live for the annual staffing and talent acquisition leadership webinar.](https://www.linkedin.com/posts/bullhorn_annual-webinar-activity-7200000000000000002/)
4h ago
`;

const RECENCY_VARIED_FIXTURE = `
## Recency Varied Feed

[Automation in recruiting pipelines is transforming candidate engagement.](https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000010/)
1h

[Stop treating recruitment candidates like order takers and build real pipelines.](https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000011/)
4h ago

[Best talent acquisition leaders always prioritize quality over sheer volume.](https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000012/)
2d ago

[Building meaningful relationships with passive engineering talent takes time.](https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000013/)
5d

[Executive search requires a completely different approach than high-volume hiring.](https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000014/)
1w ago

[AI sourcing algorithms must respect candidate privacy and ethical guidelines.](https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000015/)
3w

[The future of recruitment automation will augment recruiters, not replace them.](https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000016/)
1mo ago

[Reflections on two decades in executive talent search and leadership hiring.](https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000017/)
2mo
`;

const POST_ENGAGERS_FIXTURE = `
## Liked by 3

[Jane Recruiter](https://www.linkedin.com/in/jane-recruiter)
Founder @ Acme Recruiting · 1st

## Comments 2

[Bob Seeker](https://www.linkedin.com/in/bob-seeker)
Recruiter @ TalentCo
This is a great take on sourcing automation.

[Jane Recruiter](https://www.linkedin.com/in/jane-recruiter)
Recruiter @ Acme
Agreed, automation is the way forward.
`;

describe('toActivityFeedUrl', () => {
  it('navigates company pages to /posts/?feedView=all', () => {
    expect(toActivityFeedUrl('https://www.linkedin.com/company/bullhorn/')).toBe('https://www.linkedin.com/company/bullhorn/posts/?feedView=all');
    expect(toActivityFeedUrl('https://www.linkedin.com/company/ashbyhq')).toBe('https://www.linkedin.com/company/ashbyhq/posts/?feedView=all');
  });

  it('navigates personal profiles to /recent-activity/all/', () => {
    expect(toActivityFeedUrl('https://www.linkedin.com/in/gregsavage/')).toBe('https://www.linkedin.com/in/gregsavage/recent-activity/all/');
    expect(toActivityFeedUrl('https://www.linkedin.com/in/michael-quinn-alexander')).toBe('https://www.linkedin.com/in/michael-quinn-alexander/recent-activity/all/');
  });

  it('preserves URLs that already point to feed subpaths without double-appending', () => {
    expect(toActivityFeedUrl('https://www.linkedin.com/company/bullhorn/posts/?feedView=all')).toBe('https://www.linkedin.com/company/bullhorn/posts/?feedView=all');
    expect(toActivityFeedUrl('https://www.linkedin.com/in/gregsavage/recent-activity/all/')).toBe('https://www.linkedin.com/in/gregsavage/recent-activity/all/');
  });
});

describe('relative timestamp parsing & recency checks', () => {
  it('parses short and word relative time expressions into elapsed hours', () => {
    expect(parseRelativeTimeHours('1h')).toBe(1);
    expect(parseRelativeTimeHours('4h ago')).toBe(4);
    expect(parseRelativeTimeHours('2d')).toBe(48);
    expect(parseRelativeTimeHours('5d ago')).toBe(120);
    expect(parseRelativeTimeHours('1w')).toBe(168);
    expect(parseRelativeTimeHours('3w')).toBe(504);
    expect(parseRelativeTimeHours('1mo ago')).toBe(720);
    expect(parseRelativeTimeHours('2mo')).toBe(1440);
    expect(parseRelativeTimeHours('2 days ago')).toBe(48);
    expect(parseRelativeTimeHours('1 week ago')).toBe(168);
    expect(parseRelativeTimeHours('3 hours ago')).toBe(3);
  });

  it('evaluates recency windows correctly', () => {
    // past-24h
    expect(isWithinRecency(1, 'past-24h')).toBe(true);
    expect(isWithinRecency(24, 'past-24h')).toBe(true);
    expect(isWithinRecency(48, 'past-24h')).toBe(false);

    // past-week (default: <= 168h)
    expect(isWithinRecency(48, 'past-week')).toBe(true);
    expect(isWithinRecency(120, 'past-week')).toBe(true);
    expect(isWithinRecency(168, 'past-week')).toBe(true);
    expect(isWithinRecency(504, 'past-week')).toBe(false);

    // past-month (<= 720h)
    expect(isWithinRecency(504, 'past-month')).toBe(true);
    expect(isWithinRecency(720, 'past-month')).toBe(true);
    expect(isWithinRecency(1440, 'past-month')).toBe(false);
  });
});

describe('parseTargetProfileMarkdown', () => {
  it('extracts recent post permalinks with text and empty author placeholder', () => {
    const posts = parseTargetProfileMarkdown(PROFILE_FEED_FIXTURE);
    expect(posts).toHaveLength(2);
    expect(posts[0].postUrl).toContain('urn:li:activity:7100000000000000001');
    expect(posts[0].postText).toContain('Retail recruiters');
    expect(posts[0].authorName).toBe('');
  });

  it('handles company posts feed markdown cleanly', () => {
    const posts = parseTargetProfileMarkdown(COMPANY_POSTS_FIXTURE, 'past-week');
    expect(posts).toHaveLength(2);
    expect(posts[0].postUrl).toContain('bullhorn_recruitment-ai');
    expect(posts[1].postUrl).toContain('bullhorn_annual-webinar');
  });

  it('filters posts by recency window', () => {
    // past-24h: only 1h and 4h
    const past24h = parseTargetProfileMarkdown(RECENCY_VARIED_FIXTURE, 'past-24h');
    expect(past24h.map(p => p.postUrl)).toEqual([
      'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000010/',
      'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000011/',
    ]);

    // past-week: 1h, 4h, 2d, 5d, 1w
    const pastWeek = parseTargetProfileMarkdown(RECENCY_VARIED_FIXTURE, 'past-week');
    expect(pastWeek.map(p => p.postUrl)).toEqual([
      'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000010/',
      'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000011/',
      'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000012/',
      'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000013/',
      'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000014/',
    ]);

    // past-month: 1h, 4h, 2d, 5d, 1w, 3w, 1mo (excludes 2mo)
    const pastMonth = parseTargetProfileMarkdown(RECENCY_VARIED_FIXTURE, 'past-month');
    expect(pastMonth.map(p => p.postUrl)).toEqual([
      'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000010/',
      'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000011/',
      'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000012/',
      'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000013/',
      'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000014/',
      'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000015/',
      'https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000016/',
    ]);
  });

  it('dedupes identical post URLs and rejects short/empty bodies', () => {
    const duplicated = `${PROFILE_FEED_FIXTURE}\n[Greg Savage](https://www.linkedin.com/in/gregsavage)\n[dup](https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/)\n`;
    expect(parseTargetProfileMarkdown(duplicated)).toHaveLength(2);
    expect(parseTargetProfileMarkdown('no posts here')).toEqual([]);
    expect(parseTargetProfileMarkdown('')).toEqual([]);
  });
});

describe('parsePostEngagersMarkdown', () => {
  it('extracts likers and commenters with headlines and comment text', () => {
    const entries = parsePostEngagersMarkdown(POST_ENGAGERS_FIXTURE);
    expect(entries).toHaveLength(2);

    const jane = entries.find(e => e.name === 'Jane Recruiter')!;
    expect(jane.interaction).toBe('LIKE');
    expect(jane.profileUrl).toBe('https://www.linkedin.com/in/jane-recruiter');
    expect(jane.headline).toBe('Founder @ Acme Recruiting · 1st');
    expect(jane.commentText).toBeUndefined();

    const bob = entries.find(e => e.name === 'Bob Seeker')!;
    expect(bob.interaction).toBe('COMMENT');
    expect(bob.headline).toBe('Recruiter @ TalentCo');
    expect(bob.commentText).toBe('This is a great take on sourcing automation.');
  });

  it('dedupes an engager appearing in both sections by profile URL', () => {
    const entries = parsePostEngagersMarkdown(POST_ENGAGERS_FIXTURE);
    const janes = entries.filter(e => e.name === 'Jane Recruiter');
    expect(janes).toHaveLength(1);
  });

  it('skips entries outside a known reacted/commented section', () => {
    const markdown = '[No Section Person](https://www.linkedin.com/in/no-section)\n\n## Comments\n[Real Commenter](https://www.linkedin.com/in/real-commenter)\nRecruiter @ Co\nNice point.\n';
    const entries = parsePostEngagersMarkdown(markdown);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Real Commenter');
  });

  it('returns an empty array for empty or malformed output', () => {
    expect(parsePostEngagersMarkdown('')).toEqual([]);
    expect(parsePostEngagersMarkdown('nothing here')).toEqual([]);
  });
});

describe('OpenCliPostEngagerRunner (injected runner, no process spawn)', () => {
  function buildRunner(openOutput: string, extractOutput: string) {
    const calls: string[][] = [];
    const runner = async (args: string[]): Promise<string> => {
      calls.push(args);
      if (args.includes('open')) return openOutput;
      return extractOutput;
    };
    return { runner: runner as (args: string[], options: { timeoutMs: number }) => Promise<string>, calls };
  }

  it('derives page id from open output and parses extracted markdown', async () => {
    const { runner, calls } = buildRunner(JSON.stringify({ page: 'tab-7' }), POST_ENGAGERS_FIXTURE);
    const client = new OpenCliPostEngagerRunner({ runner, waitMs: 0 });

    const entries = await client.fetchEngagers('https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/');
    expect(entries.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(2);
    expect(calls[0].includes('browser')).toBe(true);
    expect(calls[0].includes('linkedin')).toBe(true);
    expect(calls[1]).toContain('extract');
    expect(calls[1]).toContain('--tab');
    expect(calls[1]).toContain('tab-7');
  });

  it('supports raw stdout fallback and JSON content extraction', async () => {
    const raw = new OpenCliPostEngagerRunner({ runner: async (args) => args.includes('open') ? JSON.stringify({ page: 'tab-raw' }) : POST_ENGAGERS_FIXTURE, waitMs: 0 });
    const fromRaw = await raw.fetchEngagers('https://www.linkedin.com/feed/update/urn:li:activity:1/');
    expect(fromRaw.length).toBeGreaterThan(0);

    const json = new OpenCliPostEngagerRunner({ runner: async (args) => args.includes('open') ? JSON.stringify({ page: 'tab-json' }) : JSON.stringify({ content: PROFILE_FEED_FIXTURE }), waitMs: 0 });
    const fromJson = await json.fetchRecentPosts('https://www.linkedin.com/in/gregsavage');
    expect(fromJson.length).toBeGreaterThan(0);
    expect(fromJson[0]).toMatchObject<Partial<TargetPost>>({ postUrl: expect.stringContaining('urn:li:activity:') as string });
  });

  it('navigates company pages to posts feed and personal profiles to recent-activity', async () => {
    const { runner, calls } = buildRunner(JSON.stringify({ page: 'tab-feed' }), PROFILE_FEED_FIXTURE);
    const client = new OpenCliPostEngagerRunner({ runner, waitMs: 0 });

    await client.fetchRecentPosts('https://www.linkedin.com/company/bullhorn/');
    expect(calls[0]).toContain('https://www.linkedin.com/company/bullhorn/posts/?feedView=all');

    await client.fetchRecentPosts('https://www.linkedin.com/in/gregsavage/');
    expect(calls[2]).toContain('https://www.linkedin.com/in/gregsavage/recent-activity/all/');
  });

  it('throws OPENCLI_NO_PAGE_TARGET without a usable tab id and never fabricates', async () => {
    const client = new OpenCliPostEngagerRunner({ runner: async () => 'random log line', waitMs: 0 });
    await expect(client.fetchEngagers('https://www.linkedin.com/posts/1')).rejects.toThrow('OPENCLI_NO_PAGE_TARGET');
  });

  it('returns empty engager lists for empty extraction output', async () => {
    const client = new OpenCliPostEngagerRunner({ runner: async () => JSON.stringify({ page: 'tab-1' }), waitMs: 0 });
    // First call returns the page id; the extract call returns empty content.
    const entries: PostEngagerEntry[] = await client.fetchEngagers('https://www.linkedin.com/posts/x');
    expect(entries).toEqual([]);
  });
});