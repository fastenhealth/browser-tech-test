import { getDomain } from 'tldts';

export function isCrossSite(firstUrl: string, secondUrl: string): boolean {
  const firstSite = schemefulSite(firstUrl);
  const secondSite = schemefulSite(secondUrl);
  return firstSite === null || secondSite === null || firstSite !== secondSite;
}

function schemefulSite(input: string): string | null {
  try {
    const url = new URL(input);
    const registrableDomain =
      getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname.toLowerCase();
    return `${url.protocol}//${registrableDomain}`;
  } catch {
    return null;
  }
}
