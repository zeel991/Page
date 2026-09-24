import { describe, expect, it } from 'vitest';
import { UnsafeUrlError, type SafeResponse } from '@pager/providers';
import { probeDeployedRevision } from '../src/deployed-revision.ts';

const ok = (body: object): SafeResponse => ({ status: 200, headers: {}, body: JSON.stringify(body) });
const status = (code: number, headers: Record<string, string> = {}): SafeResponse => ({ status: code, headers, body: '' });

function sequence(...responses: (SafeResponse | Error)[]) {
  let i = 0;
  const waits: number[] = [];
  return {
    get: async () => {
      const r = responses[Math.min(i++, responses.length - 1)]!;
      if (r instanceof Error) throw r;
      return r;
    },
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    calls: () => i,
    waits,
  };
}

describe('probeDeployedRevision', () => {
  it('reads the commit', async () => {
    const s = sequence(ok({ commit: 'abc1234def' }));
    expect((await probeDeployedRevision('https://svc/health', s)).sha).toBe('abc1234def');
  });

  // One throttled request used to skip the whole tick, every tick.
  it('retries a 429, honouring Retry-After, then succeeds', async () => {
    const s = sequence(status(429, { 'retry-after': '2' }), ok({ commit: 'abc1234def' }));
    const probe = await probeDeployedRevision('https://svc/health', s);
    expect(probe.sha).toBe('abc1234def');
    expect(s.waits).toEqual([2000]);
  });

  it('gives up after its attempts and says why', async () => {
    const s = sequence(status(503), status(503), status(503));
    const probe = await probeDeployedRevision('https://svc/health', s);
    expect(probe.sha).toBeNull();
    expect(probe.problem).toMatch(/503 after 3 attempt/);
    expect(s.calls()).toBe(3);
  });

  it('does not retry a 404', async () => {
    const s = sequence(status(404), ok({ commit: 'abc1234def' }));
    expect((await probeDeployedRevision('https://svc/health', s)).sha).toBeNull();
    expect(s.calls()).toBe(1);
  });

  it('does not retry a URL refused as unsafe', async () => {
    const s = sequence(new UnsafeUrlError('the host resolves to a private or reserved address'));
    const probe = await probeDeployedRevision('https://svc/health', s);
    expect(probe.problem).toMatch(/refused/);
    expect(s.calls()).toBe(1);
  });
});
