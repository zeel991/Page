import { signToken } from '@pager/core';

/**
 * Tokens the console's server presents to the API. Server-side only: the secret
 * never reaches a browser, and neither do these tokens.
 */
const BASE = process.env.PAGER_API_URL ?? 'http://127.0.0.1:4000';

function secret(): string {
  const s = process.env.PAGER_SESSION_SECRET;
  if (!s) throw new Error('PAGER_SESSION_SECRET is not set; the console cannot authenticate to the API.');
  return s;
}

/** A one-minute token for this user acting in this workspace. */
export function sessionToken(userId: string, organizationId: string): string {
  return signToken(secret(), 'api-session', { sub: userId, org: organizationId }, 60);
}

/** A call to the API's internal surface (sign-in), which no browser can reach. */
export async function internalCall<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${signToken(secret(), 'internal', {}, 60)}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return (await res.json()) as T;
}
