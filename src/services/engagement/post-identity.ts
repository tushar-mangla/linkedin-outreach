/**
 * Stable identity for a LinkedIn post. Native activity IDs survive the URL
 * variants emitted by LinkedIn; a normalized URL is the conservative fallback.
 */
export function canonicalPostIdentifier(postUrl: string): string {
  const activity = postUrl.match(/(?:urn:li:activity:|activity[-:/])([0-9]+)/i)?.[1];
  if (activity) return `linkedin:activity:${activity}`;

  const postMatch = postUrl.match(/(#post-[0-9]+)/i);
  const postFragment = postMatch ? postMatch[1].toLowerCase() : '';

  const normalized = postUrl
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?/i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();

  return `linkedin:url:${normalized}${postFragment}`;
}

/**
 * Strict gate: only real LinkedIn post/activity permalinks are eligible for
 * engagement actions. Accepts /posts/{author}/{slug}, /posts/activity-{id}-{slug}
 * (single-segment share form), and feed/update urn forms. Rejects profile URLs,
 * synthetic #post-N fragments, non-linkedin hosts, bare /posts/{one-segment}
 * (unless activity- form), and trailing garbage (end-anchored).
 */
export function isValidLinkedInPostUrl(url: string): boolean {
  if (typeof url !== 'string' || url.trim() === '') return false;
  const trimmed = url.trim();
  // Must be http(s)
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    const u = new URL(trimmed);
    if (!/^(www\.)?linkedin\.com$/i.test(u.hostname)) return false;
    const path = u.pathname;
    // Accept:
    // /posts/{author-slug}/{post-slug}
    // /posts/activity-{id}-{slug}   (single-segment share URL form recognized by canonicalPostIdentifier)
    // /feed/update/urn:li:activity:NNN , ugcPost, share
    // End-anchored to reject trailing garbage.
    const ok = /^\/posts\/(?:[^/?#]+\/[^/?#]+|activity-\d+[^/?#]*)\/?$/.test(path) ||
               /^\/feed\/update\/urn:li:(?:activity|ugcPost|share):\d+\/?$/.test(path);
    return ok;
  } catch {
    return false;
  }
}
