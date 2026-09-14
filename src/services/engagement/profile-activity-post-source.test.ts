import { describe, expect, it, vi, beforeEach } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

import { ProfileActivityPostSource } from './profile-activity-post-source.js';

const PROFILE_URL = 'https://www.linkedin.com/in/prospect-abc';

function opencliItem(overrides: Record<string, unknown> = {}) {
  return {
    body: 'This is a sufficiently long post body about recruitment operations and hiring trends.',
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678',
    author: 'Prospect Author',
    ...overrides,
  };
}

describe('ProfileActivityPostSource (no synthetic #post-N URLs)', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('keeps items with verifiable http(s) post URLs', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, result: { stdout: string }) => void) => {
      cb(null, {
        stdout: JSON.stringify([
          opencliItem({ url: 'https://www.linkedin.com/posts/author/slug-activity-123456-hash' }),
          opencliItem({ url: 'http://www.linkedin.com/feed/update/urn:li:activity:123' }),
        ]),
      });
    });
    const source = new ProfileActivityPostSource();
    const posts = await source.findRecentPosts('prospect-1', 'tenant-1', PROFILE_URL);
    expect(posts).toHaveLength(2);
    expect(posts[0].postUrl).toBe('https://www.linkedin.com/posts/author/slug-activity-123456-hash');
    expect(posts[1].postUrl).toBe('http://www.linkedin.com/feed/update/urn:li:activity:123');
  });

  it('skips items without a URL instead of fabricating a synthetic #post-N profile-feed URL', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, result: { stdout: string }) => void) => {
      cb(null, {
        stdout: JSON.stringify([
          opencliItem({ url: undefined }),
          opencliItem({ url: '' }),
          opencliItem({ url: 'not-a-url' }),
          opencliItem({ url: 'https://www.linkedin.com/feed/update/urn:li:activity:42' }),
        ]),
      });
    });
    const source = new ProfileActivityPostSource();
    const posts = await source.findRecentPosts('prospect-1', 'tenant-1', PROFILE_URL);
    expect(posts).toHaveLength(1);
    expect(posts[0].postUrl).toBe('https://www.linkedin.com/feed/update/urn:li:activity:42');
    expect(posts.some((p) => p.postUrl.includes('#post-'))).toBe(false);
    expect(posts.some((p) => p.postUrl.includes('/recent-activity/all/'))).toBe(false);
  });

  it('skips items with short body text', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, result: { stdout: string }) => void) => {
      cb(null, {
        stdout: JSON.stringify([
          opencliItem({ body: 'short' }),
          opencliItem({ body: 'This body is long enough to be considered a real post.' }),
        ]),
      });
    });
    const source = new ProfileActivityPostSource();
    const posts = await source.findRecentPosts('prospect-1', 'tenant-1', PROFILE_URL);
    expect(posts).toHaveLength(1);
  });

  it('returns an empty array when OpenCLI returns no posts', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, result: { stdout: string }) => void) => {
      cb(null, { stdout: JSON.stringify([]) });
    });
    const source = new ProfileActivityPostSource();
    const posts = await source.findRecentPosts('prospect-1', 'tenant-1', PROFILE_URL);
    expect(posts).toEqual([]);
  });
});
