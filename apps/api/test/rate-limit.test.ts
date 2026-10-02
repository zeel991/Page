import { afterEach, describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/rate-limit.ts';
import { harness, type Harness } from './harness.ts';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('RateLimiter', () => {
  it('allows the limit in a window, refuses beyond it, and resets with the window', () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 2, windowMs: 1000, now: () => now });
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(true);
    const third = limiter.hit('a');
    expect(third).toMatchObject({ allowed: false, remaining: 0 });
    expect(limiter.hit('b').allowed).toBe(true);
    now = 1000;
    expect(limiter.hit('a').allowed).toBe(true);
  });
});

// Before, the API had no limit at all: one caller could send as many requests as it
// liked. With open sign-up, one workspace must not be able to starve the others.
describe('API rate limits', () => {
  it('limits console routes per signed-in person, not per address', async () => {
    h = await harness({ rateLimits: { console: { limit: 3, windowMs: 60_000 } } });
    const alice = await h.signIn('alice', '2001');
    const bob = await h.signIn('bob', '2002');
    for (let i = 0; i < 3; i++) expect((await h.call('GET', '/api/onboarding', alice.token)).statusCode).toBe(200);
    const refused = await h.call('GET', '/api/onboarding', alice.token);
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    // Same address, a different person: unaffected.
    expect((await h.call('GET', '/api/onboarding', bob.token)).statusCode).toBe(200);
  });

  it('limits webhooks per sender before verifying anything', async () => {
    h = await harness({ rateLimits: { webhooks: { limit: 2, windowMs: 60_000 } } });
    const send = () => h!.app.inject({ method: 'POST', url: '/webhooks/github', payload: '{}', headers: { 'content-type': 'application/json' } });
    expect((await send()).statusCode).not.toBe(429);
    expect((await send()).statusCode).not.toBe(429);
    expect((await send()).statusCode).toBe(429);
  });
});
