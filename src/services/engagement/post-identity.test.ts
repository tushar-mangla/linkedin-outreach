import { describe, expect, it } from 'vitest';
import { canonicalPostIdentifier } from './post-identity.js';

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
