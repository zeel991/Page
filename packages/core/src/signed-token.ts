import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived signed tokens: the console's identity on API calls, and the `state`
 * that ties an install flow (GitHub App, Slack) back to the workspace that began it.
 *
 * HMAC-SHA256 over a JSON payload, with a purpose and an expiry. A token minted for
 * one purpose is refused for any other, so an install `state` can never be replayed
 * as an API session, and a session can never stand in for an install.
 *
 * Deliberately not a general JWT: nothing here needs an algorithm header, and not
 * having one removes the class of bugs where the header chooses the verifier.
 */

export type TokenPurpose = 'api-session' | 'internal' | 'github-install' | 'slack-install';

export interface SignedClaims {
  purpose: TokenPurpose;
  /** Seconds since the epoch. */
  exp: number;
  [key: string]: unknown;
}

export class InvalidTokenError extends Error {
  constructor(reason: string) {
    super(`Refusing token: ${reason}`);
    this.name = 'InvalidTokenError';
  }
}

const MIN_SECRET_LENGTH = 32;

function mac(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

function assertSecret(secret: string | undefined): asserts secret is string {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new InvalidTokenError(`the signing secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
}

export function signToken(
  secret: string | undefined,
  purpose: TokenPurpose,
  claims: Record<string, unknown>,
  ttlSeconds: number,
  now: Date = new Date(),
): string {
  assertSecret(secret);
  const payload: SignedClaims = { ...claims, purpose, exp: Math.floor(now.getTime() / 1000) + ttlSeconds };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(secret, `${purpose}.${body}`)}`;
}

export function verifyToken<T extends Record<string, unknown>>(
  secret: string | undefined,
  purpose: TokenPurpose,
  token: string | undefined | null,
  now: Date = new Date(),
): T & SignedClaims {
  assertSecret(secret);
  if (!token) throw new InvalidTokenError('no token');
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) throw new InvalidTokenError('malformed');

  const expected = Buffer.from(mac(secret, `${purpose}.${body}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new InvalidTokenError('bad signature');
  }

  let claims: SignedClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedClaims;
  } catch {
    throw new InvalidTokenError('unreadable payload');
  }
  if (claims.purpose !== purpose) throw new InvalidTokenError('wrong purpose');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now.getTime()) throw new InvalidTokenError('expired');
  return claims as T & SignedClaims;
}
