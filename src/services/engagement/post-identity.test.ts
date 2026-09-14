import { describe, expect, it } from 'vitest';
import { canonicalPostIdentifier, isValidLinkedInPostUrl } from './post-identity.js';

describe('canonicalPostIdentifier', () => {
  describe('Activity URNs and URLs', () => {
    it('canonicalizes bare activity URN with short numeric id', () => {
      expect(canonicalPostIdentifier('urn:li:activity:123')).toBe('linkedin:activity:123');
    });

    it('canonicalizes uppercase activity URN', () => {
      expect(canonicalPostIdentifier('URN:LI:ACTIVITY:123')).toBe('linkedin:activity:123');
    });

    it('canonicalizes full LinkedIn update URLs with activity URN', () => {
      expect(
        canonicalPostIdentifier('https://www.linkedin.com/feed/update/urn:li:activity:123/')
      ).toBe('linkedin:activity:123');
      expect(
        canonicalPostIdentifier('https://linkedin.com/feed/update/urn:li:activity:123')
      ).toBe('linkedin:activity:123');
    });

    it('canonicalizes full LinkedIn update URLs with trailing slash, query params, and tracking fragments', () => {
      expect(
        canonicalPostIdentifier(
          'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/?trk=feed'
        )
      ).toBe('linkedin:activity:7123456789012345678');
      expect(
        canonicalPostIdentifier(
          'https://linkedin.com/feed/update/urn:li:activity:7123456789012345678/#comment'
        )
      ).toBe('linkedin:activity:7123456789012345678');
    });

    it('canonicalizes post URLs with activity prefix slug', () => {
      expect(
        canonicalPostIdentifier('https://www.linkedin.com/posts/activity-7123456789012345678-abcd')
      ).toBe('linkedin:activity:7123456789012345678');
      expect(
        canonicalPostIdentifier('https://www.linkedin.com/feed/update/activity:123/')
      ).toBe('linkedin:activity:123');
    });
  });

  describe('Feed post fallback with fragments', () => {
    it('canonicalizes feed post URLs with trailing slash before #post-N fragment', () => {
      expect(
        canonicalPostIdentifier('https://linkedin.com/in/foo/recent-activity/all/#post-0')
      ).toBe('linkedin:url:linkedin.com/in/foo/recent-activity/all#post-0');
    });

    it('canonicalizes feed post URLs with query strings attached after #post-N fragment', () => {
      expect(
        canonicalPostIdentifier('https://www.linkedin.com/in/foo/recent-activity/all#post-0?utm=test')
      ).toBe('linkedin:url:linkedin.com/in/foo/recent-activity/all#post-0');
    });

    it('canonicalizes feed post URLs with trailing slash and query parameters', () => {
      expect(
        canonicalPostIdentifier('https://linkedin.com/in/foo/recent-activity/all/#post-0?utm=test')
      ).toBe('linkedin:url:linkedin.com/in/foo/recent-activity/all#post-0');
      expect(
        canonicalPostIdentifier('https://www.linkedin.com/in/foo/recent-activity/all/?utm=test#post-0')
      ).toBe('linkedin:url:linkedin.com/in/foo/recent-activity/all#post-0');
    });

    it('strips protocol, www, and lowercases hostname and path with #post-N', () => {
      expect(
        canonicalPostIdentifier('http://www.linkedin.com/in/foo/recent-activity/all/#post-1')
      ).toBe('linkedin:url:linkedin.com/in/foo/recent-activity/all#post-1');
      expect(
        canonicalPostIdentifier('https://WWW.LINKEDIN.COM/IN/FOO/RECENT-ACTIVITY/ALL/#POST-0')
      ).toBe('linkedin:url:linkedin.com/in/foo/recent-activity/all#post-0');
    });
  });

  describe('Standard post URLs with query strings and trailing slashes', () => {
    it('normalizes standard post URLs stripping trailing slashes consistently', () => {
      expect(
        canonicalPostIdentifier('https://www.linkedin.com/posts/foo-bar-12345/')
      ).toBe('linkedin:url:linkedin.com/posts/foo-bar-12345');
      expect(
        canonicalPostIdentifier('https://www.linkedin.com/posts/foo-bar-12345')
      ).toBe('linkedin:url:linkedin.com/posts/foo-bar-12345');
    });

    it('strips query parameters and trailing slashes', () => {
      expect(
        canonicalPostIdentifier(
          'https://www.linkedin.com/posts/foo-bar-12345/?utm_source=share&utm_medium=member_desktop'
        )
      ).toBe('linkedin:url:linkedin.com/posts/foo-bar-12345');
      expect(
        canonicalPostIdentifier('https://www.linkedin.com/posts/foo-bar-12345?utm_source=share')
      ).toBe('linkedin:url:linkedin.com/posts/foo-bar-12345');
    });

    it('strips non-#post-[0-9]+ hash fragments', () => {
      expect(
        canonicalPostIdentifier('https://www.linkedin.com/posts/foo-bar-12345/#comments')
      ).toBe('linkedin:url:linkedin.com/posts/foo-bar-12345');
      expect(
        canonicalPostIdentifier('https://www.linkedin.com/posts/foo-bar-12345/?utm=test#comments')
      ).toBe('linkedin:url:linkedin.com/posts/foo-bar-12345');
    });

    it('strips http/https and optional www and lowercases hostname and path', () => {
      expect(
        canonicalPostIdentifier('http://linkedin.com/posts/foo-bar-12345/')
      ).toBe('linkedin:url:linkedin.com/posts/foo-bar-12345');
      expect(
        canonicalPostIdentifier('https://WWW.LinkedIn.COM/Posts/Foo-Bar-12345/')
      ).toBe('linkedin:url:linkedin.com/posts/foo-bar-12345');
      expect(
        canonicalPostIdentifier('https://www.linkedin.com/in/someone/recent-activity/all/')
      ).toBe('linkedin:url:linkedin.com/in/someone/recent-activity/all');
    });
  });
});

describe('isValidLinkedInPostUrl', () => {
  describe('accepts real LinkedIn post/activity permalinks', () => {
    it('accepts feed update activity URLs with query strings', () => {
      expect(isValidLinkedInPostUrl('https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/?trk=feed')).toBe(true);
      expect(isValidLinkedInPostUrl('https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678?trk=feed&utm_source=share')).toBe(true);
    });

    it('accepts feed update activity URLs without www and with http', () => {
      expect(isValidLinkedInPostUrl('https://linkedin.com/feed/update/urn:li:activity:123')).toBe(true);
      expect(isValidLinkedInPostUrl('http://www.linkedin.com/feed/update/urn:li:activity:123')).toBe(true);
    });

    it('accepts ugcPost and share URN forms', () => {
      expect(isValidLinkedInPostUrl('https://www.linkedin.com/feed/update/urn:li:ugcPost:123456789')).toBe(true);
      expect(isValidLinkedInPostUrl('https://www.linkedin.com/feed/update/urn:li:share:987654321')).toBe(true);
    });

    it('accepts /posts/{author}/{slug} permalinks with query and fragment suffixes', () => {
      expect(isValidLinkedInPostUrl('https://www.linkedin.com/posts/author-slug/activity-7123456789012345678-abcd')).toBe(true);
      expect(isValidLinkedInPostUrl('https://www.linkedin.com/posts/author-slug/slug-activity-123456-hash')).toBe(true);
      expect(isValidLinkedInPostUrl('http://www.linkedin.com/posts/author/slug-123?utm_source=share#comments')).toBe(true);
    });
  });

  describe('rejects synthetic, profile, malformed, and non-LinkedIn URLs', () => {
    it('rejects synthetic #post-N profile-feed fragments', () => {
      expect(isValidLinkedInPostUrl('https://www.linkedin.com/in/foo/recent-activity/all/#post-0')).toBe(false);
      expect(isValidLinkedInPostUrl('https://www.linkedin.com/in/foo/recent-activity/all/#post-1?utm=test')).toBe(false);
    });

    it('rejects profile feed and profile URLs', () => {
      expect(isValidLinkedInPostUrl('https://www.linkedin.com/in/foo/recent-activity/all/')).toBe(false);
      expect(isValidLinkedInPostUrl('https://www.linkedin.com/in/foo')).toBe(false);
    });

    it('rejects non-LinkedIn hosts and host-suffix lookalikes', () => {
      expect(isValidLinkedInPostUrl('https://fixture.test/posts/a/b')).toBe(false);
      expect(isValidLinkedInPostUrl('https://example.com/feed/update/urn:li:activity:123')).toBe(false);
      expect(isValidLinkedInPostUrl('https://www.linkedin.com.evil.com/posts/a/b')).toBe(false);
    });

    it('rejects bare /posts/{one-segment} and non-numeric activity ids', () => {
      expect(isValidLinkedInPostUrl('https://www.linkedin.com/posts/foo')).toBe(false);
      expect(isValidLinkedInPostUrl('https://www.linkedin.com/feed/update/urn:li:activity:abc')).toBe(false);
    });

    it('rejects malformed, empty, and scheme-less inputs', () => {
      expect(isValidLinkedInPostUrl('not-a-url')).toBe(false);
      expect(isValidLinkedInPostUrl('')).toBe(false);
      expect(isValidLinkedInPostUrl('   ')).toBe(false);
      expect(isValidLinkedInPostUrl('urn:li:activity:123')).toBe(false);
      expect(isValidLinkedInPostUrl('www.linkedin.com/posts/a/b')).toBe(false);
    });
  });

  describe('documented boundary behavior (characterization)', () => {
    it('accepts single-segment /posts/activity-{id}-{slug} (recognized by canonicalPostIdentifier as valid LinkedIn share URL)', () => {
      // /posts/activity-... is a valid single-segment form for some LinkedIn share URLs
      expect(canonicalPostIdentifier('https://www.linkedin.com/posts/activity-7123456789012345678-abcd')).toBe('linkedin:activity:7123456789012345678');
      expect(isValidLinkedInPostUrl('https://www.linkedin.com/posts/activity-7123456789012345678-abcd')).toBe(true);
      expect(isValidLinkedInPostUrl('https://www.linkedin.com/posts/activity-7123456789012345678')).toBe(true);
    });

    it('rejects /posts/activity-... without digits so it aligns with canonicalPostIdentifier', () => {
      expect(isValidLinkedInPostUrl('https://www.linkedin.com/posts/activity-nonnumeric')).toBe(false);
      expect(isValidLinkedInPostUrl('https://www.linkedin.com/posts/activity-')).toBe(false);
      expect(isValidLinkedInPostUrl('https://www.linkedin.com/posts/activity-foobar-slug')).toBe(false);
    });

    it('rejects trailing path segments / garbage after valid prefix (end-anchored regex)', () => {
      expect(isValidLinkedInPostUrl('https://www.linkedin.com/feed/update/urn:li:activity:123/extra')).toBe(false);
      expect(isValidLinkedInPostUrl('https://www.linkedin.com/feed/update/urn:li:activity:123abc')).toBe(false);
    });
  });
});
