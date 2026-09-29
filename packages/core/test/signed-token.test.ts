import { describe, expect, it } from 'vitest';
import { InvalidTokenError, signToken, verifyToken } from '../src/signed-token.js';

const SECRET = 's'.repeat(40);
const NOW = new Date('2026-09-29T12:00:00Z');

describe('signed tokens', () => {
  it('round-trips claims for their purpose', () => {
    const t = signToken(SECRET, 'api-session', { sub: 'u1', org: 'o1' }, 60, NOW);
    expect(verifyToken(SECRET, 'api-session', t, NOW)).toMatchObject({ sub: 'u1', org: 'o1', purpose: 'api-session' });
  });

  it('refuses a token minted for another purpose', () => {
    // An install state must never be usable as a session, or vice versa.
    const state = signToken(SECRET, 'github-install', { org: 'o1' }, 600, NOW);
    expect(() => verifyToken(SECRET, 'api-session', state, NOW)).toThrow(/bad signature|wrong purpose/);
  });

  it('refuses a tampered, expired or foreign token', () => {
    const t = signToken(SECRET, 'api-session', { sub: 'u1', org: 'o1' }, 60, NOW);
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'u1', org: 'o2', purpose: 'api-session', exp: 9e9 })).toString('base64url');
    expect(() => verifyToken(SECRET, 'api-session', `${forged}.${sig}`, NOW)).toThrow(InvalidTokenError);
    expect(() => verifyToken(SECRET, 'api-session', t, new Date(NOW.getTime() + 61_000))).toThrow(/expired/);
    expect(() => verifyToken('x'.repeat(40), 'api-session', t, NOW)).toThrow(/bad signature/);
    expect(() => verifyToken(SECRET, 'api-session', `${body}`, NOW)).toThrow(/malformed/);
  });

  it('refuses to sign with a short secret', () => {
    expect(() => signToken('short', 'api-session', {}, 60)).toThrow(/at least 32/);
  });
});
