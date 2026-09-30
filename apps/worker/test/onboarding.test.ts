import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobQueue, eq, plans, revisionRuns } from '@pager/db';
import { ScriptedPatchGenerator, SCRIPTS } from '@pager/agents';
import { LocalProcessRunner } from '@pager/sandbox';
import { harness, healthServer, onboard, type Harness } from '../../api/test/harness.ts';
import { Worker } from '../src/worker.ts';
import type { JobContext } from '../src/jobs.ts';

let h: Harness;
let health: Awaited<ReturnType<typeof healthServer>>;
let clock: Date;
const now = () => clock;

beforeEach(async () => {
  h = await harness();
  const deployed = h.twin.current.repositories.get('acme/checkout-api')!.branches.get('main')!;
  health = await healthServer(() => deployed);
  clock = new Date('2026-09-13T15:10:00Z');
});
afterEach(async () => {
  await health.close();
  await h.close();
});

function worker() {
  const queue = new JobQueue(h.handle.db, { workerId: 'w1', now });
  const ctx: JobContext = {
    op: { db: h.handle.db, vault: h.vault, github: h.github, slackBaseUrl: h.endpoints.slack, allowPrivateHealthUrl: true, now },
    queue,
    sandboxRunner: new LocalProcessRunner(),
    agentsFor: () => ({ patchGenerator: new ScriptedPatchGenerator(SCRIPTS['INC-001']!) }),
    mergeButton: false,
    log: () => {},
  };
  return new Worker(queue, ctx, { log: () => {} });
}

type Steps = { steps: { id: string; status: string }[]; plan: { services: { used: number; limit: number } } };

describe('onboarding', () => {
  it('reports each step from what actually exists', async () => {
    const fresh = await h.signIn('carol', '3003');
    const before = (await h.call('GET', '/api/onboarding', fresh.token)).json() as Steps;
    expect(before.steps.filter((s) => s.status === 'done').map((s) => s.id)).toEqual(['signed_in']);

    const { session, service } = await onboard(h, { healthUrl: health.url });
    let after = (await h.call('GET', '/api/onboarding', session.token)).json() as Steps;
    const status = (s: Steps) => Object.fromEntries(s.steps.map((x) => [x.id, x.status]));
    expect(status(after)).toMatchObject({ github: 'done', repository: 'done', slack: 'done', service: 'done', datadog: 'attention', health: 'attention', watching: 'attention' });

    await h.call('POST', '/api/integrations/datadog/test', session.token);
    await h.call('POST', `/api/services/${service.id}/test-health`, session.token);
    await worker().schedulePolls();
    await worker().drain();
    after = (await h.call('GET', '/api/onboarding', session.token)).json() as Steps;
    expect(status(after)).toMatchObject({ datadog: 'done', health: 'done' });
    expect(after.plan.services).toEqual({ used: 1, limit: 1 });
  });

  it('refuses a second service on the free plan', async () => {
    const { session, repositoryId } = await onboard(h, { healthUrl: health.url });
    const res = await h.call('POST', '/api/services', session.token, { name: 'second', repositoryId, healthUrl: health.url, slackChannelId: '#incidents' });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'plan_limit' });
  });

  it('does not open an incident past the plan’s monthly allowance', async () => {
    const { session } = await onboard(h, { healthUrl: health.url });
    await h.handle.db.update(plans).set({ maxIncidentsPerMonth: 0 }).where(eq(plans.id, 'free'));
    const w = worker();
    await w.schedulePolls();
    await w.drain();
    expect(await h.handle.db.select().from(revisionRuns)).toEqual([]);
    const svc = (await h.call('GET', '/api/services', session.token)).json() as { services: { lastPollOutcome: string }[] };
    expect(svc.services[0]!.lastPollOutcome).toMatch(/Free plan's 0 incidents this month are used/);
  });

  it('sends a test incident that a workspace with nothing connected can see', async () => {
    const fresh = await h.signIn('dana', '4004');
    const queued = await h.call('POST', '/api/test-incident', fresh.token);
    expect(queued.statusCode).toBe(200);
    // Only one at a time.
    expect((await h.call('POST', '/api/test-incident', fresh.token)).statusCode).toBe(409);
    // The API queued it on the real clock; the sample runs on its own scripted clock.
    clock = new Date();
    await worker().drain();

    const list = (await h.call('GET', '/api/incidents', fresh.token)).json() as { incidents: { state: string; serviceId: string }[] };
    expect(list.incidents).toEqual([expect.objectContaining({ state: 'AWAITING_APPROVAL' })]);
    const services = (await h.call('GET', '/api/services', fresh.token)).json() as { services: { name: string; alertSource: string; enabled: boolean }[] };
    expect(services.services).toEqual([expect.objectContaining({ name: 'sample-checkout-api', alertSource: 'sample', enabled: false })]);
    const onboarding = (await h.call('GET', '/api/onboarding', fresh.token)).json() as { testIncident: { status: string }; plan: { services: { used: number } } };
    expect(onboarding.testIncident.status).toBe('done');
    // A sample does not use the plan.
    expect(onboarding.plan.services.used).toBe(0);
  });
});
