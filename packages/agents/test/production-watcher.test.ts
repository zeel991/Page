import { afterEach, describe, expect, it } from 'vitest';
import { DatadogProvider, NotionProvider } from '@pager/providers';
import { AgentTracer, InMemorySink } from '@pager/observability';
import { INC_001, INC_009, INC_011, LocalTwinServer, seedFromFixture } from '@pager/twin-local';
import { ProductionWatcher, describeAlert, extractKnownFailureModes } from '../src/production-watcher.js';

let server: LocalTwinServer;
let endpoints: Awaited<ReturnType<LocalTwinServer['start']>>;

async function start(fixtureSpec: Parameters<typeof seedFromFixture>[0]) {
  server = new LocalTwinServer({ now: () => Date.parse('2026-09-13T14:45:00Z') });
  server.seed(seedFromFixture(fixtureSpec));
  endpoints = await server.start();
}

afterEach(async () => {
  await server?.stop();
});

/** The fixture's wall clock. The window now ends at now, so tests must fix it. */
const FIXTURE_NOW = () => new Date('2026-09-13T15:10:00Z');

function watcher(withRunbooks = true) {
  const observability = new DatadogProvider({ baseUrl: endpoints.datadog });
  const knowledge = withRunbooks
    ? new NotionProvider({ baseUrl: endpoints.notion, token: 't' })
    : null;
  return new ProductionWatcher(observability, knowledge);
}

const tracer = () => {
  const sink = new InMemorySink();
  return { sink, tracer: new AgentTracer({ sink, lemma: null }) };
};

describe('extractKnownFailureModes', () => {
  it('picks up an error type with where and how it fails', () => {
    const modes = extractKnownFailureModes([
      { title: 'Runbook', content: '- Gateway 503s surface as PaymentGatewayError with frames inside @acme/payments-sdk.' },
    ]);
    expect(modes).toEqual([
      expect.objectContaining({ errorType: 'PaymentGatewayError', locations: ['@acme/payments-sdk'], messages: ['503'], source: 'Runbook' }),
    ]);
  });

  it('keeps a type-only mention with nothing to match on', () => {
    const [mode] = extractKnownFailureModes([{ title: 'R', content: '- PaymentGatewayError means the upstream is down.' }]);
    expect(mode).toMatchObject({ errorType: 'PaymentGatewayError', locations: [], messages: [] });
  });

  it('does not register a failure mode from prose alone', () => {
    // "sometimes the gateway is slow" must not silence a novel gateway crash.
    expect(
      extractKnownFailureModes([{ title: 'R', content: 'Sometimes the gateway is slow at peak.' }]),
    ).toHaveLength(0);
  });

  it('deduplicates a mode mentioned in several places', () => {
    const modes = extractKnownFailureModes([
      { title: 'A', content: 'PaymentGatewayError happens.' },
      { title: 'B', content: 'See PaymentGatewayError again.' },
    ]);
    expect(modes).toHaveLength(1);
  });
});

describe('ProductionWatcher', () => {
  it('escalates a novel failure with a located application frame', async () => {
    await start(INC_001);
    const { tracer: t } = tracer();

    const alert = await t.run('ProductionWatcher', {}, (ctx) =>
      watcher().check(ctx, 'checkout-api', { now: FIXTURE_NOW }),
    );

    expect(alert).not.toBeNull();
    expect(alert!.escalate).toBe(true);
    expect(alert!.primary!.errorType).toBe('TypeError');
    expect(alert!.primary!.topApplicationFrame!.file).toContain('src/checkout/service.ts');
    expect(describeAlert(alert!)).toContain('src/checkout/service.ts:20');
    expect(alert!.rationale).toMatch(/match no documented failure mode/);
  });

  it('does not escalate a failure the runbook already documents', async () => {
    // INC-009's runbook names PaymentGatewayError explicitly.
    await start(INC_009);
    const { tracer: t } = tracer();

    const alert = await t.run('ProductionWatcher', {}, (ctx) =>
      watcher().check(ctx, 'checkout-api', { now: FIXTURE_NOW }),
    );

    expect(alert!.primary!.errorType).toBe('PaymentGatewayError');
    expect(alert!.escalate).toBe(false);
    expect(alert!.novelty!.matched!.errorType).toBe('PaymentGatewayError');
    expect(alert!.rationale).toMatch(/Handle via its runbook/);
  });

  it('escalates that same failure when the runbooks are unavailable', async () => {
    // Losing context must err toward waking someone, not toward silence.
    await start(INC_009);
    const { tracer: t } = tracer();

    const alert = await t.run('ProductionWatcher', {}, (ctx) =>
      watcher(false).check(ctx, 'checkout-api', { now: FIXTURE_NOW }),
    );

    expect(alert!.escalate).toBe(true);
  });

  it('refuses to escalate an alerting monitor with no errors beneath it', async () => {
    // INC-011: production is healthy, the monitor thresholds on a count.
    await start(INC_011);
    const { tracer: t } = tracer();

    const alert = await t.run('ProductionWatcher', {}, (ctx) =>
      watcher().check(ctx, 'checkout-api', { now: FIXTURE_NOW }),
    );

    expect(alert).not.toBeNull();
    expect(alert!.clusters).toHaveLength(0);
    expect(alert!.escalate).toBe(false);
    expect(alert!.rationale).toMatch(/more likely a monitor problem than a production one/);
  });

  it('returns nothing when no monitor is alerting', async () => {
    await start(INC_001);
    const { tracer: t } = tracer();
    const alert = await t.run('ProductionWatcher', {}, (ctx) =>
      watcher().check(ctx, 'some-other-service'),
    );
    expect(alert).toBeNull();
  });

  it('records every provider call it made', async () => {
    await start(INC_001);
    const { sink, tracer: t } = tracer();
    await t.run('ProductionWatcher', {}, (ctx) => watcher().check(ctx, 'checkout-api', { now: FIXTURE_NOW }));

    const names = sink.toolCalls.map((c) => c.toolName);
    expect(names).toContain('datadog.listMonitors');
    expect(names).toContain('datadog.queryLogs');
    expect(sink.failedToolCalls()).toHaveLength(0);
  });
});

/**
 * The evidence window must always reach the present.
 *
 * A monitor still in ALERT is saying the failure is happening now. Ending the
 * window a fixed interval after it first fired means that on a monitor red for an
 * hour — or one that never cleared across a deployment — every error the service is
 * currently producing falls outside the evidence. Observed live: a stuck transition
 * timestamp led to four investigations of a defect that was no longer deployed,
 * while the live failure went unexamined.
 */
describe('evidence window', () => {
  it('runs up to now even when the monitor fired long ago', async () => {
    await start(INC_001);
    const { tracer: t } = tracer();
    const now = new Date('2026-09-13T16:00:00Z');

    const alert = await t.run('w', {}, (ctx) => watcher().check(ctx, 'checkout-api', { now: () => now }));
    expect(alert).not.toBeNull();
    // Not firedAt + a fixed lookahead, which ended well before now.
    expect(alert!.logWindow.to.toISOString()).toBe(now.toISOString());
    expect(alert!.logWindow.to.getTime()).toBeGreaterThan(alert!.firedAt.getTime());
  });

  it('bounds how far back a long-running alert may reach', async () => {
    await start(INC_001);
    const { tracer: t } = tracer();
    const now = new Date('2026-09-13T20:00:00Z');

    const alert = await t.run('w', {}, (ctx) =>
      watcher().check(ctx, 'checkout-api', { now: () => now, maxWindowMinutes: 45 }),
    );
    const spanMinutes = (alert!.logWindow.to.getTime() - alert!.logWindow.from.getTime()) / 60_000;
    expect(spanMinutes).toBeLessThanOrEqual(45);
  });

  it('still reaches back before the transition to catch onset', async () => {
    await start(INC_001);
    const { tracer: t } = tracer();
    const now = new Date('2026-09-13T14:45:00Z');

    const alert = await t.run('w', {}, (ctx) =>
      watcher().check(ctx, 'checkout-api', { now: () => now, lookbackMinutes: 15 }),
    );
    expect(alert!.logWindow.from.getTime()).toBeLessThan(alert!.firedAt.getTime());
  });
});

describe('ProductionWatcher with several distinct failures', () => {
  const at = new Date('2026-09-13T15:00:00Z');
  const entry = (message: string, frame: string) => ({
    at,
    service: 'svc',
    level: 'error' as const,
    message,
    stackTrace: `${message}\n    at handler (${frame})\n    at node:internal/process/task_queues:95:5`,
    attributes: {},
  });
  const observability = (logs: ReturnType<typeof entry>[]) =>
    ({
      kind: 'observability',
      listMonitors: async () => [{ id: 'm1', name: 'svc errors', status: 'ALERT', transitionedAt: at, query: '', message: '' }],
      queryLogs: async () => Object.assign(logs, { truncated: false }),
    }) as unknown as ConstructorParameters<typeof ProductionWatcher>[0];

  it('reports one failure per root frame, loudest first, each assessed for novelty', async () => {
    const logs = [
      ...Array(5).fill(0).map(() => entry("TypeError: Cannot read properties of undefined (reading 'total')", '/app/src/cart.ts:12:5')),
      // A different message from the same line: a different signature, the same bug.
      ...Array(2).fill(0).map(() => entry('TypeError: cart.lines is not iterable', '/app/src/cart.ts:12:5')),
      ...Array(3).fill(0).map(() => entry('RangeError: Invalid time value', '/app/src/invoice.ts:40:9')),
    ];
    const { tracer: t } = tracer();
    const alert = await t.run('ProductionWatcher', {}, (ctx) => new ProductionWatcher(observability(logs)).check(ctx, 'svc', { now: () => at }));
    // The old watcher looked only at the loudest cluster and missed the RangeError.
    expect(alert!.failures.map((f) => [f.key, f.cluster.errorType, f.novelty.novel])).toEqual([
      ['/app/src/cart.ts:12', 'TypeError', true],
      ['/app/src/invoice.ts:40', 'RangeError', true],
    ]);
    expect(alert!.clusters).toHaveLength(3);
    expect(alert!.escalate).toBe(true);
    expect(alert!.rationale).toMatch(/1 other distinct failure/);
  });

  it('caps the failures it reports', async () => {
    const logs = [1, 2, 3, 4, 5].map((n) => entry(`Error: e${n}`, `/app/src/f${n}.ts:${n}:1`));
    const { tracer: t } = tracer();
    const alert = await t.run('ProductionWatcher', {}, (ctx) =>
      new ProductionWatcher(observability(logs)).check(ctx, 'svc', { now: () => at, maxFailures: 2 }),
    );
    expect(alert!.failures).toHaveLength(2);
  });
});
