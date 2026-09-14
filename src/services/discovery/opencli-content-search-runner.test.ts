import { describe, expect, it } from 'vitest';
import { parseContentSearchMarkdown } from './opencli-content-search-runner.js';

const FIXTURE_MARKDOWN = `
## Search results

[Jane Doe](https://www.linkedin.com/in/jane-doe)
[Manual sourcing is killing our margins this quarter. We need a better pipeline.](https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/)
2d ago

[Bob Seeker](https://www.linkedin.com/in/bob-seeker)
[I am #OpenToWork and looking for my next role.](https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000002/)
1d ago
`;

describe('parseContentSearchMarkdown', () => {
  it('extracts posts with author name and profile URL', () => {
    const posts = parseContentSearchMarkdown(FIXTURE_MARKDOWN);
    expect(posts).toHaveLength(2);
    expect(posts[0].postUrl).toContain('urn:li:activity:7000000000000000001');
    expect(posts[0].postText).toContain('Manual sourcing is killing our margins');
    expect(posts[0].authorName).toBe('Jane Doe');
    expect(posts[0].authorProfileUrl).toBe('https://www.linkedin.com/in/jane-doe');
  });

  it('dedupes identical post URLs', () => {
    const markdown = `${FIXTURE_MARKDOWN}\n[Jane Doe](https://www.linkedin.com/in/jane-doe)\n[Duplicate post](https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/)\n`;
    const posts = parseContentSearchMarkdown(markdown);
    expect(posts).toHaveLength(2);
  });

  it('returns an empty array for unparseable output', () => {
    expect(parseContentSearchMarkdown('no posts here')).toEqual([]);
    expect(parseContentSearchMarkdown('')).toEqual([]);
  });
});