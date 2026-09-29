import { JobQueue, ServiceConfigRepository, type JobRow } from '@pager/db';
import { redactSecrets } from '@pager/core';
import { handle, type JobContext } from './jobs.ts';

/**
 * The worker: claims jobs from the queue and runs them.
 *
 * Holds nothing between jobs. Several workers can run against one database; a
 * worker that is killed leaves its jobs' leases to expire, and another reclaims
 * them. The one piece of standing work — every enabled service has a poll queued —
 * is re-established on every scheduler pass rather than remembered.
 */

export interface WorkerOptions {
  /** Jobs this process runs at once. The queue's `maxRunning` caps all processes together. */
  concurrency?: number;
  /** How often a running job renews its lease. */
  heartbeatMs?: number;
  log?: (line: string) => void;
}

export class Worker {
  private readonly running = new Set<Promise<void>>();
  private stopped = false;
  private readonly concurrency: number;
  private readonly heartbeatMs: number;
  private readonly log: (line: string) => void;

  // Plain fields, not parameter properties: this file runs under Node's type
  // stripping, which does not support them.
  private readonly queue: JobQueue;
  private readonly ctx: JobContext;

  constructor(queue: JobQueue, ctx: JobContext, opts: WorkerOptions = {}) {
    this.queue = queue;
    this.ctx = ctx;
    this.concurrency = opts.concurrency ?? 2;
    this.heartbeatMs = opts.heartbeatMs ?? 30_000;
    this.log = opts.log ?? ((line) => console.log(line));
  }

  /** Make sure every enabled service has a poll queued. Idempotent: deduped by key. */
  async schedulePolls(): Promise<number> {
    const services = await new ServiceConfigRepository(this.ctx.op.db).enabledWithRepository();
    let queued = 0;
    for (const { service } of services) {
      const job = await this.queue.enqueue({
        organizationId: service.organizationId,
        serviceId: service.id,
        kind: 'poll',
        dedupeKey: `poll:${service.id}`,
        // A poll that fails keeps being retried at its interval; it never exhausts.
        maxAttempts: 1_000_000,
      });
      if (job) queued++;
    }
    return queued;
  }

  /** Claim and start as many jobs as there are free slots. Returns how many started. */
  async fill(): Promise<number> {
    let started = 0;
    while (!this.stopped && this.running.size < this.concurrency) {
      const job = await this.queue.claim();
      if (!job) break;
      const p = this.run(job).finally(() => this.running.delete(p));
      this.running.add(p);
      started++;
    }
    return started;
  }

  /** Run jobs until nothing is claimable and nothing is running. For tests and `once`. */
  async drain(): Promise<void> {
    for (;;) {
      await this.fill();
      if (this.running.size === 0) return;
      await Promise.race(this.running);
    }
  }

  async start(opts: { tickMs?: number; scheduleMs?: number } = {}): Promise<void> {
    const tickMs = opts.tickMs ?? 1_000;
    const scheduleMs = opts.scheduleMs ?? 60_000;
    let lastSchedule = 0;
    while (!this.stopped) {
      try {
        if (Date.now() - lastSchedule >= scheduleMs) {
          await this.queue.reapExpired();
          await this.schedulePolls();
          lastSchedule = Date.now();
        }
        await this.fill();
      } catch (err) {
        // A failing pass must never kill the worker: an unreachable database for a
        // minute is not a reason to stop watching production for the day.
        this.log(`worker pass failed: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
      }
      await new Promise((r) => setTimeout(r, tickMs));
    }
  }

  /** Stop claiming, and wait for running jobs to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.running]);
  }

  private async run(job: JobRow): Promise<void> {
    const beat = setInterval(() => {
      void this.queue.heartbeat(job.id).catch(() => undefined);
    }, this.heartbeatMs);
    try {
      const outcome = await handle(this.ctx, job);
      if (outcome.kind === 'done') await this.queue.complete(job.id, outcome.result ?? {});
      else if (outcome.kind === 'reschedule') await this.queue.reschedule(job.id, outcome.at, outcome.result ?? {});
      else await this.queue.block(job.id, outcome.reason);
    } catch (err) {
      const message = redactSecrets(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      const state = await this.queue.fail(job.id, message).catch(() => 'failed' as const);
      this.log(`${job.kind} ${job.id} failed (${state}): ${message}`);
    } finally {
      clearInterval(beat);
    }
  }
}
