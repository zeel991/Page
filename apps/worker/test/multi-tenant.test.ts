import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobQueue, RevisionRunRepository, incidents, jobs, revisionRuns, incidentEvents } from '@pager/db';
import { MeteredModel, ModelPatchGenerator, ScriptedPatchGenerator, type ModelClient, type WorkflowCheckpoint } from '@pager/agents';
import { UsageRepository } from '@pager/db';
import { usageMeter } from '../src/meter.ts';
import { LocalProcessRunner } from '@pager/sandbox';
import { harness, healthServer, onboard, type Harness } from '../../api/test/harness.ts';
import { Worker } from '../src/worker.ts';
import type { JobContext } from '../src/jobs.ts';
import type { OperatorServices } from '../src/tenant.ts';

/**
 * The multi-tenant worker, end to end against the local twins.
 *
 * A workspace is onboarded through the API alone — no environment variables, no
 * database writes by hand — and the worker takes it from there. The crash test kills
 * a worker part-way through an incident and checks that another one finishes it
 * without doing anything twice.
 */

const REGRESSION_TEST = `import { it } from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutService } from '../src/checkout/service.ts';
it('handles a missing discount code', () => {
  const o = new CheckoutService().createOrder({ customerId: 'c', items: [{ sku: 'A', quantity: 1, unitPriceCents: 1000 }] });
  assert.equal(o.totalCents, 1000);
});
`;

const PATCHED = `import type { OrderRequest } from './types.ts';
export interface Order { customerId: string; subtotalCents: number; discountCents: number; totalCents: number; appliedCode: string | null }
export class CheckoutService {
  createOrder(request: OrderRequest): Order {
    const subtotalCents = request.items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);
    const code = request.discountCode ?? null;
    const discountCents = code ? Math.round(subtotalCents * (code.percentOff / 100)) : 0;
    return { customerId: request.customerId, subtotalCents, discountCents, totalCents: subtotalCents - discountCents, appliedCode: code ? code.value : null };
  }
}
`;

const scripted = () =>
  new ScriptedPatchGenerator({
    regressionTest: {
      path: 'test/regression.test.ts',
      source: REGRESSION_TEST,
      expectedFailureMarkers: ['TypeError', "reading 'percentOff'"],
      expectedFailureDescription: 'Checkout succeeds when no discount code is supplied.',
    },
    patch: {
      rootCause: 'createOrder dereferenced an optional field',
      explanation: 'Guard it',
      files: [{ path: 'src/checkout/service.ts', content: PATCHED }],
      risks: [],
      rollbackPlan: 'Revert the merge commit.',
      confidence: 0.9,
    },
  });

let h: Harness;
let health: Awaited<ReturnType<typeof healthServer>>;
let deployed: string;
let clock: Date;
const now = () => clock;

beforeEach(async () => {
  h = await harness();
  const repo = h.twin.current.repositories.get('acme/checkout-api')!;
  deployed = repo.branches.get('main')!;
  health = await healthServer(() => deployed);
  // The fixture's telemetry is from this afternoon; the workflow's evidence window ends at "now".
  clock = new Date('2026-09-13T15:10:00Z');
});
afterEach(async () => {
  await health.close();
  await h.close();
});

function operator(): OperatorServices {
  return {
    db: h.handle.db,
    vault: h.vault,
    github: h.github,
    slackBaseUrl: h.endpoints.slack,
    notionBaseUrl: h.endpoints.notion,
    resendBaseUrl: h.endpoints.resend,
    allowPrivateHealthUrl: true,
    now,
  };
}

function worker(id: string, extra: Partial<JobContext> = {}, heartbeatMs = 30_000) {
  const queue = new JobQueue(h.handle.db, { workerId: id, leaseMs: 5 * 60_000, now });
  const ctx: JobContext = {
    op: operator(),
    queue,
    sandboxRunner: new LocalProcessRunner(),
    agentsFor: () => ({ patchGenerator: scripted() }),
    mergeButton: false,
    log: () => {},
    ...extra,
  };
  return { queue, worker: new Worker(queue, ctx, { heartbeatMs, log: () => {} }) };
}

const pullRequests = () => h.twin.current.repositories.get('acme/checkout-api')!.pullRequests;

describe('multi-tenant worker', () => {
  it('watches a service configured only through the API, and opens one pull request for it', async () => {
    const { session } = await onboard(h, { healthUrl: health.url });
    const before = pullRequests().length;
    const { worker: w } = worker('w1');
    expect(await w.schedulePolls()).toBe(1);
    await w.drain();

    const [run] = await h.handle.db.select().from(revisionRuns);
    expect(run).toMatchObject({ phase: 'awaiting_merge', deployedRevision: deployed });
    expect(pullRequests()).toHaveLength(before + 1);

    // The console shows the live incident, in its own workspace, in AWAITING_APPROVAL.
    const list = (await h.call('GET', '/api/incidents', session.token)).json() as { incidents: { state: string; id: string }[] };
    expect(list.incidents).toEqual([expect.objectContaining({ state: 'AWAITING_APPROVAL', id: run!.incidentId })]);

    // The next poll sees the revision is handled and does not open another.
    clock = new Date(clock.getTime() + 61_000);
    await w.drain();
    expect(pullRequests()).toHaveLength(before + 1);
    const services = (await h.call('GET', '/api/services', session.token)).json() as { services: { lastPollOutcome: string }[] };
    expect(services.services[0]!.lastPollOutcome).toMatch(/already handled/);
  });

  it('resumes an incident when the worker running it is killed, without doing anything twice', async () => {
    await onboard(h, { healthUrl: health.url });
    const before = pullRequests().length;
    const messagesBefore = h.twin.current.messages.length;

    // w1 dies right after it has created the fix branch, before the pull request.
    let dead = false;
    const hang = (cp: WorkflowCheckpoint) => {
      if (cp.branch) {
        dead = true;
        return new Promise<void>(() => {});
      }
    };
    const w1 = worker('w1', { onCheckpoint: hang }, 1e9);
    await w1.worker.schedulePolls();
    await w1.worker.fill(); // poll
    await new Promise((r) => setTimeout(r, 200));
    await w1.worker.fill(); // run_incident, which hangs at the branch
    for (let i = 0; i < 200 && !dead; i++) await new Promise((r) => setTimeout(r, 50));
    expect(dead).toBe(true);
    const [partial] = await h.handle.db.select().from(revisionRuns);
    expect(partial).toMatchObject({ phase: 'running', branch: `pager/inc-${deployed.slice(0, 12)}` });
    expect(partial!.incidentId).not.toBeNull();
    expect(partial!.pullRequestNumber).toBeNull();

    // w2 starts. Until w1's lease runs out it may not touch the incident.
    const w2 = worker('w2');
    await w2.worker.drain();
    expect((await h.handle.db.select().from(revisionRuns))[0]!.pullRequestNumber).toBeNull();

    clock = new Date(clock.getTime() + 6 * 60_000);
    expect(await w2.queue.reapExpired()).toBe(1);
    await w2.worker.drain();

    const runs = await h.handle.db.select().from(revisionRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ phase: 'awaiting_merge' });
    // One incident, one pull request, and one opening message — the thread was reused.
    expect(await h.handle.db.select().from(incidents)).toHaveLength(1);
    expect(pullRequests()).toHaveLength(before + 1);
    const opened = h.twin.current.messages.slice(messagesBefore).filter((m) => m.threadTs === null);
    expect(opened).toHaveLength(1);
    const timeline = await h.handle.db.select().from(incidentEvents);
    expect(timeline.map((e) => e.kind)).toContain('workflow_resumed');
    const [inc] = await h.handle.db.select().from(incidents);
    expect(inc!.state).toBe('AWAITING_APPROVAL');
  });

  it('waits on the human merge and the deploy, then verifies recovery — across a restart', async () => {
    await onboard(h, { healthUrl: health.url });
    const first = worker('w1');
    await first.worker.schedulePolls();
    await first.worker.drain();
    const runs = new RevisionRunRepository(h.handle.db);
    const [run] = await h.handle.db.select().from(revisionRuns);

    // Not merged yet: await_merge keeps waiting.
    clock = new Date(clock.getTime() + 61_000);
    await first.worker.drain();
    expect((await runs.get(run!.id))!.phase).toBe('awaiting_merge');

    // A person merges; production deploys the merge commit. The worker that saw the
    // PR opened is gone — a fresh one carries on from the database alone.
    const pr = pullRequests().find((p) => p.number === run!.pullRequestNumber)!;
    pr.merged = true;
    pr.state = 'closed';
    pr.mergedAt = clock.toISOString();
    pr.mergeCommitSha = pr.headSha;
    h.twin.current.repositories.get('acme/checkout-api')!.branches.set('main', pr.headSha);
    deployed = pr.headSha;

    const second = worker('w2');
    clock = new Date(clock.getTime() + 61_000);
    await second.worker.drain(); // await_merge sees the merge, queues verify_recovery, which sees the deploy
    expect((await runs.get(run!.id))!.phase).toBe('verifying');
    expect((await runs.get(run!.id))!.deployedAt).not.toBeNull();

    clock = new Date(clock.getTime() + 16 * 60_000);
    await second.worker.drain();
    const settled = await runs.get(run!.id);
    expect(settled!.phase).toBe('settled');
    // The twin holds no telemetry after the deploy, so recovery cannot be measured —
    // and is reported as such, not as recovered.
    expect(settled!.recoveryVerdict).toBe('UNVERIFIABLE');
    const remaining = await h.handle.db.select().from(jobs);
    expect(remaining.filter((j) => j.kind !== 'poll' && j.status !== 'done')).toEqual([]);
  });

  it('keeps two workspaces apart: each worker job acts only with its own workspace’s credentials', async () => {
    const { session } = await onboard(h, { healthUrl: health.url });
    const other = await h.signIn('bob', '1002');
    const { worker: w } = worker('w1');
    await w.schedulePolls();
    await w.drain();
    // Bob's workspace has nothing configured, so nothing ran for it and he sees nothing.
    expect(((await h.call('GET', '/api/incidents', other.token)).json() as { incidents: unknown[] }).incidents).toEqual([]);
    expect(((await h.call('GET', '/api/incidents', session.token)).json() as { incidents: unknown[] }).incidents).toHaveLength(1);
  });

  // A workspace past its monthly model budget used to keep spending: nothing checked.
  it('stops an incident at the monthly budget, and says so, without calling the model', async () => {
    const { session } = await onboard(h, { healthUrl: health.url });
    const usage = new UsageRepository(h.handle.db);
    await usage.setBudget(session.org, 5);
    await usage.record({ organizationId: session.org, kind: 'investigation', model: 'claude-opus-5-5', keySource: 'workspace', usdCost: 6, at: clock });

    let calls = 0;
    const model: ModelClient = { model: 'claude-opus-5-5', complete: async () => { calls++; throw new Error('should not be called'); } };
    const { worker: w } = worker('w1', {
      agentsFor: (tenant, scope) => {
        const meter = usageMeter(
          h.handle.db,
          { organizationId: tenant.service.organizationId, serviceId: tenant.service.id, keySource: 'workspace', incidentId: scope.incidentId },
          () => usage.budget(tenant.service.organizationId),
          now,
        );
        return { patchGenerator: new ModelPatchGenerator({ model: new MeteredModel(model, meter, 'patch'), tracer: tenant.tracer }) };
      },
    });
    await w.schedulePolls();
    await w.drain();

    expect(calls).toBe(0);
    const [run] = await h.handle.db.select().from(revisionRuns);
    expect(run).toMatchObject({ phase: 'budget_reached' });
    expect(run!.outcome).toMatch(/\$6\.00 spent of \$5\.00/);
    const blocked = (await h.handle.db.select().from(jobs)).find((j) => j.kind === 'run_incident')!;
    expect(blocked.status).toBe('budget_blocked');
    const timeline = await h.handle.db.select().from(incidentEvents);
    expect(timeline.map((e) => e.kind)).toContain('budget_reached');
    // The console reports the spend it is judging against.
    const report = (await h.call('GET', '/api/usage', session.token)).json() as { monthToDate: { usd: number }; monthlyBudgetUsd: number };
    expect(report).toMatchObject({ monthToDate: { usd: 6 }, monthlyBudgetUsd: 5 });
  });
});
