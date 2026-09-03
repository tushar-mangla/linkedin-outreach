
export function normalizeLinkedinUrl(url: string): string {
  let urlObj: URL;
  try {
    urlObj = new URL(url);
  } catch {
    throw new Error('Invalid LinkedIn URL');
  }

  const hostname = urlObj.hostname.toLowerCase().replace(/^www\./, '').replace(/^[a-z]{2}\./, '');
  if (hostname !== 'linkedin.com') {
    throw new Error('URL must belong to linkedin.com');
  }

  const pathname = urlObj.pathname.replace(/\/+$/, '');
  const profileMatch = pathname.match(/^\/in\/([^/]+)$/i);
  if (profileMatch) {
    return `https://linkedin.com/in/${profileMatch[1].toLowerCase()}`;
  }

  const companyMatch = pathname.match(/^\/company\/([^/]+)$/i);
  if (companyMatch) {
    return `https://linkedin.com/company/${companyMatch[1].toLowerCase()}`;
  }

  throw new Error('URL must be a LinkedIn profile or company URL');
}
