import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SentryProvider, nextCursor } from '@pager/providers';
import { LocalTwinServer } from '../src/server.js';
import { seedFromFixture } from '../src/seed.js';
import { INC_001, INC_020 } from '../src/fixtures/index.js';

let server: LocalTwinServer;
let base: string;
const now = () => new Date('2026-09-13T14:50:00Z');
const window = { from: new Date('2026-09-13T14:20:00Z'), to: new Date('2026-09-13T14:50:00Z') };

async function start(fixture = INC_001) {
  server = new LocalTwinServer({ now: () => now().getTime() });
  server.seed(seedFromFixture(fixture));
  base = (await server.start()).sentry;
}
afterEach(async () => {
  await server.stop();
});

const sentry = (over: Partial<ConstructorParameters<typeof SentryProvider>[0]> = {}) =>
  new SentryProvider({ baseUrl: base, token: 'sntrys_test', organization: 'acme', now, ...over });

describe('SentryProvider against the twin', () => {
  beforeEach(async () => {
    await start();
  });

  it('reports a new, active issue as alerting', async () => {
    const alerts = await sentry().listAlerts('checkout-api');
    expect(alerts).toEqual([
      expect.objectContaining({ status: 'ALERT', service: 'checkout-api', name: expect.stringMatching(/TypeError: Cannot read properties of null/) }),
    ]);
  });

  it('reads structured frames straight from the events, innermost first, with Sentry’s in-app flag', async () => {
    const errors = await sentry().readErrors('checkout-api', window);
    expect(errors.kind).toBe('groups');
    if (errors.kind !== 'groups') return;
    const [group] = errors.groups;
    expect(group).toMatchObject({ errorType: 'TypeError', count: 24, routes: ['POST /checkout'] });
    expect(group!.frames[0]).toEqual({ file: '/app/src/checkout/service.ts', line: 20, column: 52, functionName: 'CheckoutService.createOrder', inApp: true });
    expect(group!.frames.at(-1)).toMatchObject({ file: 'node:internal/process/task_queues', inApp: false });
    expect(errors.truncated).toBe(false);
  });

  it('follows the Link header across pages, and says when it stopped with more', async () => {
    server.current.sentry.pageSize = { issues: 1, events: 5 };
    const all = await sentry().readErrors('checkout-api', window);
    expect(all.kind === 'groups' && all.groups[0]!.count).toBe(24);
    const capped = await sentry({ maxEventsPerIssue: 10 }).readErrors('checkout-api', window);
    expect(capped.kind === 'groups' && [capped.groups[0]!.count, capped.truncated]).toEqual([10, true]);
  });

  it('waits out a rate limit as Sentry asks, rather than failing', async () => {
    server.current.sentry.rateLimit = { max: 2, windowMs: 1000 };
    server.current.sentry.pageSize = { issues: 1, events: 5 };
    const started = Date.now();
    const errors = await sentry().readErrors('checkout-api', window);
    expect(errors.kind === 'groups' && errors.groups[0]!.count).toBe(24);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  }, 30_000);

  it('refuses without a token, so no data is read anonymously', async () => {
    await expect(sentry({ token: '' }).listAlerts('checkout-api')).rejects.toThrow(/401/);
  });
});

describe('SentryProvider on a Python project', () => {
  it('gets Python frames from the SDK’s shape, not by parsing a traceback', async () => {
    await start(INC_020);
    const errors = await sentry().readErrors('billing-api', window);
    if (errors.kind !== 'groups') throw new Error('expected groups');
    expect(errors.groups[0]).toMatchObject({ errorType: 'KeyError' });
    expect(errors.groups[0]!.frames[0]).toMatchObject({ file: '/srv/app/billing/tax.py', line: 14, functionName: 'tax_rate', inApp: true });
  });
});

describe('nextCursor', () => {
  it('reads the next cursor only while Sentry says there are results', () => {
    expect(nextCursor('<x?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", <x?cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"')).toBe('0:100:0');
    expect(nextCursor('<x>; rel="next"; results="false"; cursor="0:100:0"')).toBeNull();
    expect(nextCursor(null)).toBeNull();
  });
});
