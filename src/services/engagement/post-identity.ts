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
