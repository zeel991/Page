import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../src/client.js';
import { migrate } from '../src/migrate.js';
import { jobs, organizations, services } from '../src/schema.js';
import { JobQueue, RevisionRunRepository } from '../src/jobs.js';

let handle: DatabaseHandle;
let org: string;
let svcA: string;
let svcB: string;
let clock: Date;
const now = () => clock;

beforeEach(async () => {
  handle = await createDatabase('pglite://memory');
  await migrate(handle);
  const [o] = await handle.db.insert(organizations).values({ name: 'A', slug: 'a' }).returning();
  org = o!.id;
  const s = await handle.db.insert(services).values([{ organizationId: org, name: 'a' }, { organizationId: org, name: 'b' }]).returning();
  svcA = s[0]!.id;
  svcB = s[1]!.id;
  clock = new Date('2026-09-30T12:00:00Z');
});
afterEach(async () => {
  await handle.close();
});

const queue = (workerId: string, extra: { maxRunning?: number } = {}) =>
  new JobQueue(handle.db, { workerId, leaseMs: 60_000, now, ...extra });

describe('JobQueue', () => {
  it('refuses a duplicate of a queued or running job, and accepts it once that one is done', async () => {
    const q = queue('w1');
    expect(await q.enqueue({ organizationId: org, kind: 'poll', serviceId: svcA, dedupeKey: `poll:${svcA}` })).not.toBeNull();
    expect(await q.enqueue({ organizationId: org, kind: 'poll', serviceId: svcA, dedupeKey: `poll:${svcA}` })).toBeNull();
    const job = await q.claim();
    await q.complete(job!.id);
    expect(await q.enqueue({ organizationId: org, kind: 'poll', serviceId: svcA, dedupeKey: `poll:${svcA}` })).not.toBeNull();
  });

  it('never runs two jobs for one service at once', async () => {
    const q = queue('w1');
    await q.enqueue({ organizationId: org, kind: 'run_incident', serviceId: svcA });
    await q.enqueue({ organizationId: org, kind: 'await_merge', serviceId: svcA });
    await q.enqueue({ organizationId: org, kind: 'poll', serviceId: svcB });
    const first = await q.claim();
    const second = await q.claim();
    expect(first!.serviceId).toBe(svcA);
    // The second job for A waits; B's runs.
    expect(second!.serviceId).toBe(svcB);
    expect(await q.claim()).toBeNull();
    // And the database refuses a second running row for A even if asked directly.
    await expect(handle.pglite!.exec(`update jobs set status = 'running' where service_id = '${svcA}' and status = 'queued'`)).rejects.toThrow(/unique/);
  });

  it('holds the global cap across workers', async () => {
    for (const s of [svcA, svcB]) await queue('w1').enqueue({ organizationId: org, kind: 'poll', serviceId: s });
    expect(await queue('w1', { maxRunning: 1 }).claim()).not.toBeNull();
    expect(await queue('w2', { maxRunning: 1 }).claim()).toBeNull();
  });

  // A restarted worker used to forget everything in flight.
  it('returns a dead worker’s job to the queue when its lease expires', async () => {
    await queue('w1').enqueue({ organizationId: org, kind: 'run_incident', serviceId: svcA });
    const taken = await queue('w1').claim();
    expect(taken!.attempts).toBe(1);
    // w1 dies. Before the lease runs out, nobody may take the job.
    const w2 = queue('w2');
    expect(await w2.reapExpired()).toBe(0);
    expect(await w2.claim()).toBeNull();
    clock = new Date(clock.getTime() + 61_000);
    expect(await w2.reapExpired()).toBe(1);
    const resumed = await w2.claim();
    expect(resumed!.id).toBe(taken!.id);
    expect(resumed!.lockedBy).toBe('w2');
    expect(resumed!.attempts).toBe(2);
    // The dead worker can no longer complete what it lost.
    await queue('w1').complete(taken!.id);
    expect((await w2.get(taken!.id))!.status).toBe('running');
  });

  it('keeps a live job by heartbeat', async () => {
    await queue('w1').enqueue({ organizationId: org, kind: 'run_incident', serviceId: svcA });
    const q = queue('w1');
    const job = await q.claim();
    clock = new Date(clock.getTime() + 50_000);
    expect(await q.heartbeat(job!.id)).toBe(true);
    clock = new Date(clock.getTime() + 50_000);
    expect(await queue('w2').reapExpired()).toBe(0);
  });

  it('retries a failure with backoff, then gives up', async () => {
    const q = queue('w1');
    await q.enqueue({ organizationId: org, kind: 'poll', serviceId: svcA, maxAttempts: 2 });
    let job = await q.claim();
    expect(await q.fail(job!.id, 'boom')).toBe('retrying');
    expect(await q.claim()).toBeNull();
    clock = new Date(clock.getTime() + 120_000);
    job = await q.claim();
    expect(await q.fail(job!.id, 'boom again')).toBe('failed');
    expect((await q.get(job!.id))!.status).toBe('failed');
  });

  it('does not count waiting as an attempt', async () => {
    const q = queue('w1');
    await q.enqueue({ organizationId: org, kind: 'await_merge', serviceId: svcA, maxAttempts: 1 });
    for (let i = 0; i < 5; i++) {
      const job = await q.claim();
      expect(job).not.toBeNull();
      await q.reschedule(job!.id, clock);
    }
    expect((await handle.db.select().from(jobs))[0]!.status).toBe('queued');
  });
});

describe('RevisionRunRepository', () => {
  it('records one run per service and revision', async () => {
    const runs = new RevisionRunRepository(handle.db);
    const first = await runs.begin(org, svcA, 'abc');
    const again = await runs.begin(org, svcA, 'abc');
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.run.id).toBe(first.run.id);
    expect((await runs.begin(org, svcB, 'abc')).created).toBe(true);
  });
});
