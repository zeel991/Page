import { and, eq, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { isUniqueViolation } from './repositories.js';
import { jobs, revisionRuns } from './schema.js';

export type JobRow = typeof jobs.$inferSelect;
export type JobKind = 'poll' | 'run_incident' | 'await_merge' | 'verify_recovery' | 'test_incident';
export type RevisionRunRow = typeof revisionRuns.$inferSelect;

/** Serialises claimers for the moment of a claim, so the global cap is honoured. */
const CLAIM_LOCK = 7_340_031;

export interface JobQueueOptions {
  workerId: string;
  /** How long a claim is held without a heartbeat before another worker may take it. */
  leaseMs?: number;
  /** Jobs running at once, across every worker. */
  maxRunning?: number;
  now?: () => Date;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/**
 * A job queue in Postgres.
 *
 * Claiming is `FOR UPDATE SKIP LOCKED` inside a transaction that first takes a
 * transaction-scoped advisory lock, so the global cap is checked and the claim made
 * atomically. At most one job per service runs at once: the claim skips a service
 * with a running job, and a partial unique index refuses a second regardless.
 *
 * The per-service exclusion is that index and a lease, not a session advisory lock:
 * an incident job runs for minutes, and a session lock would pin a pooled
 * connection for all of it and vanish silently if the connection dropped.
 */
export class JobQueue {
  private readonly leaseMs: number;
  private readonly maxRunning: number;
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    private readonly opts: JobQueueOptions,
  ) {
    this.leaseMs = opts.leaseMs ?? 5 * 60_000;
    this.maxRunning = opts.maxRunning ?? 4;
    this.now = opts.now ?? (() => new Date());
  }

  /** Queue a job. Returns null when an identical one (same dedupe key) is already queued or running. */
  async enqueue(input: {
    organizationId: string;
    kind: JobKind;
    serviceId?: string | null;
    incidentId?: string | null;
    payload?: Record<string, unknown>;
    dedupeKey?: string | null;
    runAt?: Date;
    maxAttempts?: number;
  }): Promise<JobRow | null> {
    try {
      const [row] = await this.db
        .insert(jobs)
        .values({
          organizationId: input.organizationId,
          kind: input.kind,
          serviceId: input.serviceId ?? null,
          incidentId: input.incidentId ?? null,
          payload: input.payload ?? {},
          dedupeKey: input.dedupeKey ?? null,
          runAt: input.runAt ?? this.now(),
          maxAttempts: input.maxAttempts ?? 3,
        })
        .returning();
      return row!;
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  /** The next runnable job, now held by this worker, or null. */
  async claim(): Promise<JobRow | null> {
    const now = this.now();
    const leaseUntil = new Date(now.getTime() + this.leaseMs);
    const tx = (this.db as unknown as { transaction: <T>(fn: (tx: Database) => Promise<T>) => Promise<T> }).transaction.bind(this.db);
    return tx(async (t) => {
      await t.execute(sql`select pg_advisory_xact_lock(${CLAIM_LOCK})`);
      const [running] = rowsOf<{ n: number }>(
        await t.execute(sql`select count(*)::int as n from jobs where status = 'running' and lease_until > ${now.toISOString()}::timestamptz`),
      );
      if ((running?.n ?? 0) >= this.maxRunning) return null;

      const [next] = rowsOf<{ id: string }>(
        await t.execute(sql`
          select j.id from jobs j
          where j.status = 'queued' and j.run_at <= ${now.toISOString()}::timestamptz
            and (j.service_id is null or not exists (
              select 1 from jobs r where r.service_id = j.service_id and r.status = 'running'))
          order by j.run_at asc
          limit 1
          for update skip locked`),
      );
      if (!next) return null;
      const [claimed] = await t
        .update(jobs)
        .set({ status: 'running', lockedBy: this.opts.workerId, leaseUntil, attempts: sql`${jobs.attempts} + 1`, updatedAt: now })
        .where(and(eq(jobs.id, next.id), eq(jobs.status, 'queued')))
        .returning();
      return claimed ?? null;
    });
  }

  /** Extend this worker's lease on a running job. False if it is no longer ours. */
  async heartbeat(jobId: string): Promise<boolean> {
    const now = this.now();
    const rows = await this.db
      .update(jobs)
      .set({ leaseUntil: new Date(now.getTime() + this.leaseMs), updatedAt: now })
      .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running'), eq(jobs.lockedBy, this.opts.workerId)))
      .returning();
    return rows.length > 0;
  }

  async complete(jobId: string, result: Record<string, unknown> = {}): Promise<void> {
    const now = this.now();
    await this.db
      .update(jobs)
      .set({ status: 'done', result, lockedBy: null, leaseUntil: null, updatedAt: now, finishedAt: now })
      .where(and(eq(jobs.id, jobId), eq(jobs.lockedBy, this.opts.workerId)));
  }

  /**
   * Run this job again later. Not a failure: waiting on a human merge or a deploy is
   * the job doing its work, so the attempt is not counted.
   */
  async reschedule(jobId: string, runAt: Date, result: Record<string, unknown> = {}): Promise<void> {
    await this.db
      .update(jobs)
      .set({ status: 'queued', runAt, result, lockedBy: null, leaseUntil: null, attempts: sql`greatest(${jobs.attempts} - 1, 0)`, updatedAt: this.now() })
      .where(and(eq(jobs.id, jobId), eq(jobs.lockedBy, this.opts.workerId)));
  }

  /** Record a failure; retry with backoff until the job's attempts run out. */
  async fail(jobId: string, error: string): Promise<'retrying' | 'failed'> {
    const [job] = await this.db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!job) return 'failed';
    const now = this.now();
    const exhausted = job.attempts >= job.maxAttempts;
    await this.db
      .update(jobs)
      .set({
        status: exhausted ? 'failed' : 'queued',
        lastError: error.slice(0, 4000),
        lockedBy: null,
        leaseUntil: null,
        runAt: exhausted ? job.runAt : new Date(now.getTime() + 30_000 * 2 ** job.attempts),
        updatedAt: now,
        ...(exhausted ? { finishedAt: now } : {}),
      })
      .where(eq(jobs.id, jobId));
    return exhausted ? 'failed' : 'retrying';
  }

  /** Stop a job for a reason that retrying will not change (a budget, a plan limit). */
  async block(jobId: string, reason: string): Promise<void> {
    const now = this.now();
    await this.db
      .update(jobs)
      .set({ status: 'budget_blocked', lastError: reason, lockedBy: null, leaseUntil: null, updatedAt: now, finishedAt: now })
      .where(eq(jobs.id, jobId));
  }

  /**
   * Return jobs whose worker stopped renewing its lease to the queue — this is what
   * makes a restart resume rather than lose work. A job out of attempts fails.
   */
  async reapExpired(): Promise<number> {
    const now = this.now();
    const rows = rowsOf<{ id: string }>(
      await this.db.execute(sql`
        update jobs set
          status = (case when attempts >= max_attempts then 'failed' else 'queued' end)::job_status,
          last_error = 'lease expired: the worker running it stopped',
          locked_by = null, lease_until = null, updated_at = ${now.toISOString()}::timestamptz,
          finished_at = case when attempts >= max_attempts then ${now.toISOString()}::timestamptz else null end
        where status = 'running' and lease_until < ${now.toISOString()}::timestamptz
        returning id`),
    );
    return rows.length;
  }

  async get(jobId: string): Promise<JobRow | null> {
    const [row] = await this.db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    return row ?? null;
  }

  /** Queue depth by kind and status. Contains no tenant data. */
  async counts(): Promise<{ kind: string; status: string; n: number }[]> {
    return rowsOf(await this.db.execute(sql`select kind, status::text as status, count(*)::int as n from jobs group by kind, status order by kind, status`));
  }
}

/**
 * The durable record of what the worker did for one deployed revision of one
 * service. See `revisionRuns`.
 */
export class RevisionRunRepository {
  constructor(private readonly db: Database) {}

  /** The run for this revision, created if new. `created` says which. */
  async begin(organizationId: string, serviceId: string, deployedRevision: string): Promise<{ run: RevisionRunRow; created: boolean }> {
    const [inserted] = await this.db
      .insert(revisionRuns)
      .values({ organizationId, serviceId, deployedRevision })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { run: inserted, created: true };
    const existing = await this.find(serviceId, deployedRevision);
    return { run: existing!, created: false };
  }

  async find(serviceId: string, deployedRevision: string): Promise<RevisionRunRow | null> {
    const [row] = await this.db
      .select()
      .from(revisionRuns)
      .where(and(eq(revisionRuns.serviceId, serviceId), eq(revisionRuns.deployedRevision, deployedRevision)))
      .limit(1);
    return row ?? null;
  }

  async get(id: string): Promise<RevisionRunRow | null> {
    const [row] = await this.db.select().from(revisionRuns).where(eq(revisionRuns.id, id)).limit(1);
    return row ?? null;
  }

  async update(id: string, patch: Partial<typeof revisionRuns.$inferInsert>): Promise<RevisionRunRow> {
    const [row] = await this.db
      .update(revisionRuns)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(revisionRuns.id, id))
      .returning();
    return row!;
  }

  async byPullRequest(serviceId: string, pullRequestNumber: number): Promise<RevisionRunRow | null> {
    const [row] = await this.db
      .select()
      .from(revisionRuns)
      .where(and(eq(revisionRuns.serviceId, serviceId), eq(revisionRuns.pullRequestNumber, pullRequestNumber)))
      .limit(1);
    return row ?? null;
  }
}
