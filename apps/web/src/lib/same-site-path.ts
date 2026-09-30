/**
 * The path to return to after sign-in. Middleware sends an absolute URL; only its
 * path is kept, so a callback URL from a query string (which is attacker-chosen) can
 * never send anyone off this site.
 */
export function sameSitePath(callbackUrl: string | undefined): string | null {
  if (!callbackUrl) return null;
  let url: URL;
  try {
    url = new URL(callbackUrl, 'http://same.site');
  } catch {
    return null;
  }
  // `//evil.example` in the path would be read as another host.
  const path = `/${url.pathname.replace(/^\/+/, '')}${url.search}${url.hash}`;
  return path === '/' || path.startsWith('/signin') ? null : path;
}
