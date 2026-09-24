import { describe, expect, it } from 'vitest';
import { Http, ProviderHttpError, requestedWaitMs } from '../src/http.js';

/**
 * Vendors rate-limit and blip. A retry must be safe (never send a possibly-landed
 * write twice) and must respect what the vendor asked for.
 */
function scripted(...replies: (Response | Error)[]) {
  const calls: string[] = [];
  const waits: number[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push(`${init.method} ${url}`);
    const r = replies[Math.min(i++, replies.length - 1)]!;
    if (r instanceof Error) throw r;
    return r.clone();
  }) as unknown as typeof fetch;
  const http = new Http({ baseUrl: 'https://api.vendor.test', fetchImpl, sleep: async (ms) => void waits.push(ms) });
  return { http, calls, waits };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('Http retries', () => {
  it('retries a 429 and honours Retry-After', async () => {
    const { http, calls, waits } = scripted(json({}, 429, { 'retry-after': '3' }), json({ ok: 1 }));
    expect(await http.get('/x')).toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([3000]);
  });

  it('retries a 503 on a GET', async () => {
    const { http, calls } = scripted(json({}, 503), json({}, 503), json({ ok: 1 }));
    expect(await http.get('/x')).toEqual({ ok: 1 });
    expect(calls).toHaveLength(3);
  });

  // A POST that hit a 503 may have landed; sending it again could open a second PR.
  it('does not retry a 503 on a POST', async () => {
    const { http, calls } = scripted(json({}, 503), json({ ok: 1 }));
    await expect(http.post('/pulls', {})).rejects.toBeInstanceOf(ProviderHttpError);
    expect(calls).toHaveLength(1);
  });

  it('does retry a POST the vendor refused with 429', async () => {
    const { http, calls } = scripted(json({}, 429, { 'retry-after': '1' }), json({ number: 5 }, 201));
    expect(await http.post('/pulls', {})).toEqual({ number: 5 });
    expect(calls).toHaveLength(2);
  });

  it('retries GitHub secondary rate limits (403 with Retry-After)', async () => {
    const { http, calls } = scripted(json({}, 403, { 'retry-after': '1' }), json({ ok: 1 }));
    expect(await http.get('/x')).toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
  });

  it('does not retry an ordinary 403 or 404', async () => {
    for (const status of [403, 404]) {
      const { http, calls } = scripted(json({}, status), json({ ok: 1 }));
      await expect(http.get('/x')).rejects.toBeInstanceOf(ProviderHttpError);
      expect(calls).toHaveLength(1);
    }
  });

  it('fails now rather than wait longer than the cap', async () => {
    const { http, calls, waits } = scripted(json({}, 429, { 'retry-after': '3600' }), json({ ok: 1 }));
    await expect(http.get('/x')).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('retries a network failure on a GET but not on a POST', async () => {
    const get = scripted(new TypeError('fetch failed'), json({ ok: 1 }));
    expect(await get.http.get('/x')).toEqual({ ok: 1 });
    const post = scripted(new TypeError('fetch failed'), json({ ok: 1 }));
    await expect(post.http.post('/x', {})).rejects.toThrow('fetch failed');
    expect(post.calls).toHaveLength(1);
  });

  it('gives up after its retries', async () => {
    const { http, calls } = scripted(json({}, 503));
    await expect(http.get('/x')).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(4);
  });
});

describe('requestedWaitMs', () => {
  it('reads GitHub reset only when the budget is spent', () => {
    const now = 1_800_000_000_000;
    const headers = new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 20) });
    expect(requestedWaitMs(headers, now)).toBe(20_000);
    expect(requestedWaitMs(new Headers({ 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': String(now / 1000 + 20) }), now)).toBeNull();
  });

  it('reads Datadog reset as seconds-until', () => {
    expect(requestedWaitMs(new Headers({ 'x-ratelimit-reset': '7' }))).toBe(7_000);
  });
});
