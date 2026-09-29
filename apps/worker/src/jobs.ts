import { JobQueue, RevisionRunRepository, ServiceConfigRepository, type JobRow, type RevisionRunRow } from '@pager/db';
import {
  IncidentWorkflow,
  ProductionWatcher,
  mergeButtonBlocks,
  telemetryWindowsFor,
  type IncidentInvestigator,
  type PatchGenerator,
  type ProductionAlert,
  type WorkflowCheckpoint,
} from '@pager/agents';
import { deploymentFromRevision, probeDeployedRevision, type TimeRange } from '@pager/providers';
import type { SandboxRunner } from '@pager/sandbox';
import { decideRecoveryWindow } from './recovery-window.ts';
import { TenantUnavailable, tenantFor, type OperatorServices, type Tenant } from './tenant.ts';

/**
 * What each kind of job does.
 *
 * Every handler reads its state from the database and writes it back there; none
 * keeps anything in memory between runs. That is what lets any worker pick up any
 * job, and a job interrupted by a crash be run again by whichever worker reclaims it.
 */

export type JobOutcome =
  | { kind: 'done'; result?: Record<string, unknown> }
  | { kind: 'reschedule'; at: Date; result?: Record<string, unknown> }
  | { kind: 'blocked'; reason: string };

export interface JobContext {
  op: OperatorServices;
  queue: JobQueue;
  sandboxRunner: SandboxRunner;
  /** The reasoning steps for a tenant: model-backed in production, scripted in tests. */
  agentsFor: (tenant: Tenant) => { patchGenerator?: PatchGenerator; investigator?: IncidentInvestigator | null; model?: string };
  /** Whether a merge button may be offered (the Slack app has a signing secret). */
  mergeButton: boolean;
  log: (line: string) => void;
  /**
   * Called after each checkpoint is persisted. A test simulates a worker dying at
   * that exact point by never resolving.
   */
  onCheckpoint?: (checkpoint: WorkflowCheckpoint) => void | Promise<void>;
}

const MERGE_POLL_MS = 60_000;

const now = (c: JobContext) => (c.op.now ?? (() => new Date()))();

function incidentKeyFor(revision: string): string {
  return `INC-${revision.slice(0, 12).toUpperCase()}`;
}

function workflowFor(c: JobContext, tenant: Tenant): IncidentWorkflow {
  const agents = c.agentsFor(tenant);
  return new IncidentWorkflow({
    observability: tenant.observability,
    sourceControl: tenant.sourceControl,
    messaging: tenant.messaging,
    issueTracker: null,
    knowledge: tenant.knowledge,
    email: tenant.email,
    tracer: tenant.tracer,
    persistence: tenant.persistence,
    autonomy: tenant.autonomy,
    sandboxRunner: c.sandboxRunner,
    ...(agents.patchGenerator ? { patchGenerator: agents.patchGenerator } : {}),
    ...(agents.investigator ? { investigator: agents.investigator } : {}),
    ...(c.op.now ? { now: c.op.now } : {}),
  });
}

export async function handle(c: JobContext, job: JobRow): Promise<JobOutcome> {
  switch (job.kind) {
    case 'poll':
      return poll(c, job);
    case 'run_incident':
      return runIncident(c, job);
    case 'await_merge':
      return awaitMerge(c, job);
    case 'verify_recovery':
      return verifyRecovery(c, job);
    default:
      return { kind: 'blocked', reason: `unknown job kind ${job.kind}` };
  }
}

/**
 * One look at one service: what is deployed, is anything alerting, is it new.
 *
 * Cheap on purpose. The investigation is a separate job, so a slow incident on one
 * service never delays the poll of another.
 */
async function poll(c: JobContext, job: JobRow): Promise<JobOutcome> {
  const services = new ServiceConfigRepository(c.op.db);
  const record = (outcome: string) => services.recordPoll(job.serviceId!, outcome, now(c));

  let tenant: Tenant;
  try {
    tenant = await tenantFor(c.op, job.serviceId!);
  } catch (err) {
    if (err instanceof TenantUnavailable) {
      await record(`not watching: ${err.message}`);
      return { kind: 'done', result: { stopped: err.message } };
    }
    throw err;
  }
  const next = new Date(now(c).getTime() + tenant.service.intervalSeconds * 1000);

  const probe = await probeDeployedRevision(tenant.service.healthUrl!, { allowPrivate: c.op.allowPrivateHealthUrl });
  if (!probe.sha) {
    // "A monitor is red and we cannot see what is deployed" must not look like "all quiet".
    const alerting = await tenant.observability
      .listMonitors(tenant.service.name)
      .then((ms) => ms.filter((m) => m.status === 'ALERT').map((m) => m.name))
      .catch(() => [] as string[]);
    await record(
      alerting.length > 0
        ? `NOT INVESTIGATING: ${alerting.join(', ')} is alerting, but the deployed revision is unknown (${probe.problem})`
        : `skipped: deployed revision unknown (${probe.problem})`,
    );
    return { kind: 'reschedule', at: next };
  }

  const runs = new RevisionRunRepository(c.op.db);
  const existing = await runs.find(tenant.service.id, probe.sha);
  if (existing) {
    await record(`watching ${probe.sha.slice(0, 12)} — already handled (${existing.phase})`);
    return { kind: 'reschedule', at: next };
  }

  const watcher = new ProductionWatcher(tenant.observability, tenant.knowledge);
  const alert = await tenant.tracer.run('ProductionWatcher', { input: { service: tenant.service.name } }, (ctx) =>
    watcher.check(ctx, tenant.service.name, c.op.now ? { now: c.op.now } : {}),
  );
  if (!alert) {
    await record(`watching ${probe.sha.slice(0, 12)} — no monitor alerting`);
    return { kind: 'reschedule', at: next };
  }
  if (!alert.escalate) {
    await record(`not escalated: ${alert.rationale}`);
    return { kind: 'reschedule', at: next };
  }

  // One incident per deployed revision, recorded durably before anything is done
  // about it. A monitor stays red for as long as the bug is live; this is what stops
  // every poll from opening another pull request.
  const { run, created } = await runs.begin(tenant.service.organizationId, tenant.service.id, probe.sha);
  if (created) {
    await c.queue.enqueue({
      organizationId: tenant.service.organizationId,
      serviceId: tenant.service.id,
      kind: 'run_incident',
      payload: { runId: run.id, revision: probe.sha },
      dedupeKey: `run_incident:${run.id}`,
      // An incident run is long and expensive; retry it once, not endlessly.
      maxAttempts: 2,
    });
  }
  await record(`incident opened for ${probe.sha.slice(0, 12)}: ${alert.primary?.errorType ?? 'error'} ×${alert.primary?.count ?? 0}`);
  return { kind: 'reschedule', at: next };
}

/** Investigate, reproduce, patch, open a pull request — resuming whatever a crashed run had done. */
async function runIncident(c: JobContext, job: JobRow): Promise<JobOutcome> {
  const runs = new RevisionRunRepository(c.op.db);
  const run = await runs.get(String(job.payload.runId));
  if (!run) return { kind: 'done', result: { skipped: 'run not found' } };
  if (run.phase !== 'running') return { kind: 'done', result: { skipped: `already ${run.phase}` } };

  const tenant = await tenantFor(c.op, run.serviceId);
  const deployment = await deploymentFromRevision(tenant.sourceControl, {
    repository: tenant.repository.fullName,
    service: tenant.service.name,
    sha: run.deployedRevision,
    observedAt: now(c),
  });

  const resume: WorkflowCheckpoint = {
    ...(run.incidentId ? { incidentId: run.incidentId } : {}),
    ...(run.issueKey && run.issueUrl ? { issue: { key: run.issueKey, url: run.issueUrl } } : {}),
    ...(run.slackThreadTs && run.slackChannel ? { slackThread: { id: run.slackThreadTs, channel: run.slackChannel } } : {}),
    ...(run.branch ? { branch: run.branch } : {}),
    ...(run.pullRequestNumber && run.pullRequestUrl && run.headSha
      ? { pullRequest: { number: run.pullRequestNumber, url: run.pullRequestUrl, headSha: run.headSha } }
      : {}),
  };

  const incidentKey = run.incidentKey ?? incidentKeyFor(run.deployedRevision);
  const result = await workflowFor(c, tenant).run({
    service: tenant.service.name,
    repository: tenant.repository.fullName,
    baseBranch: tenant.service.baseBranch ?? tenant.repository.defaultBranch,
    slackChannel: tenant.service.slackChannelId!,
    deployment,
    incidentKey,
    ...(tenant.emailRecipients.length ? { teamEmails: tenant.emailRecipients } : {}),
    resume,
    onCheckpoint: async (cp) => {
      await runs.update(run.id, {
        incidentKey,
        ...(cp.incidentId ? { incidentId: cp.incidentId } : {}),
        ...(cp.issue ? { issueKey: cp.issue.key, issueUrl: cp.issue.url } : {}),
        ...(cp.slackThread ? { slackThreadTs: cp.slackThread.id, slackChannel: cp.slackThread.channel } : {}),
        ...(cp.branch ? { branch: cp.branch } : {}),
        ...(cp.pullRequest ? { pullRequestNumber: cp.pullRequest.number, pullRequestUrl: cp.pullRequest.url, headSha: cp.pullRequest.headSha } : {}),
      });
      await c.onCheckpoint?.(cp);
    },
  });

  if (!result.alert?.escalate) {
    await runs.update(run.id, { phase: 'not_escalated', outcome: result.alert?.rationale ?? 'no monitor alerting any more' });
    return { kind: 'done', result: { stage: result.stage } };
  }
  const tokens = {
    ...(result.investigation?.totalInputTokens != null ? { inputTokens: result.investigation.totalInputTokens } : {}),
    ...(result.investigation?.totalOutputTokens != null ? { outputTokens: result.investigation.totalOutputTokens } : {}),
  };

  if (!result.pullRequest || !result.slackThreadTs) {
    await runs.update(run.id, { phase: 'halted', outcome: result.haltReason ?? result.stage, ...tokens });
    return { kind: 'done', result: { stage: result.stage, halt: result.haltReason } };
  }

  // Everything the aftermath needs that a pull request number cannot carry.
  const windows = telemetryWindowsFor(result.alert.primary?.firstSeen ?? result.alert.firedAt);
  await runs.update(run.id, {
    phase: 'awaiting_merge',
    outcome: `opened ${result.pullRequest.url}`,
    alert: result.alert as unknown as Record<string, unknown>,
    rootCause: result.patch?.rootCause ?? 'see the pull request',
    baselineWindow: iso(windows[0]),
    incidentWindow: iso({ from: windows[1].from, to: now(c) }),
    ...tokens,
  });

  // At L4 a named owner or admin may merge from Slack; below it, merging happens on GitHub.
  if (c.mergeButton && (tenant.autonomy === 'L4' || tenant.autonomy === 'L5')) {
    const pr = result.pullRequest;
    await tenant.messaging
      .openThread(
        tenant.service.slackChannelId!,
        `${incidentKey}: #${pr.number} is ready for review.`,
        mergeButtonBlocks({
          headline: `${incidentKey} — fix ready for review`,
          summary:
            `*Root cause* ${result.patch?.rootCause ?? 'see the pull request'}\n` +
            `*Reproduced* \`${result.reproduction?.command ?? ''}\` exited ${result.reproduction?.beforeFix.exitCode} before the patch ` +
            `and ${result.reproduction?.afterFix?.exitCode ?? 'n/a'} after it`,
          pullRequestUrl: pr.url,
          action: { repository: tenant.repository.fullName, pullRequest: pr.number, incidentKey, headSha: pr.headSha },
        }),
      )
      .catch((err: unknown) => c.log(`could not post the merge button: ${err instanceof Error ? err.message : String(err)}`));
  }

  await c.queue.enqueue({
    organizationId: tenant.service.organizationId,
    serviceId: tenant.service.id,
    incidentId: run.incidentId ?? null,
    kind: 'await_merge',
    payload: { runId: run.id },
    dedupeKey: `await_merge:${run.id}`,
    runAt: new Date(now(c).getTime() + MERGE_POLL_MS),
  });
  return { kind: 'done', result: { pullRequest: result.pullRequest.number } };
}

/** Is the pull request merged? A human's decision, waited on without holding anything open. */
async function awaitMerge(c: JobContext, job: JobRow): Promise<JobOutcome> {
  const runs = new RevisionRunRepository(c.op.db);
  const run = await runs.get(String(job.payload.runId));
  if (!run?.pullRequestNumber || run.phase !== 'awaiting_merge') return { kind: 'done', result: { skipped: run?.phase ?? 'missing' } };
  const tenant = await tenantFor(c.op, run.serviceId);
  const pr = await tenant.sourceControl.getPullRequest(tenant.repository.fullName, run.pullRequestNumber);
  if (pr.state === 'open') return { kind: 'reschedule', at: new Date(now(c).getTime() + MERGE_POLL_MS) };
  if (pr.state !== 'merged') {
    // Closed without merging is a person deciding against the fix. Respect it.
    await runs.update(run.id, { phase: 'closed_unmerged', outcome: `#${pr.number} was closed without merging` });
    return { kind: 'done', result: { closed: true } };
  }
  await runs.update(run.id, { phase: 'verifying', mergedAt: pr.mergedAt ?? now(c) });
  await c.queue.enqueue({
    organizationId: tenant.service.organizationId,
    serviceId: tenant.service.id,
    incidentId: run.incidentId ?? null,
    kind: 'verify_recovery',
    payload: { runId: run.id },
    dedupeKey: `verify_recovery:${run.id}`,
  });
  return { kind: 'done', result: { merged: pr.number } };
}

/** Wait for the fix to be deployed and for post-fix traffic, then verify and write up. */
async function verifyRecovery(c: JobContext, job: JobRow): Promise<JobOutcome> {
  const runs = new RevisionRunRepository(c.op.db);
  const run = await runs.get(String(job.payload.runId));
  if (!run?.pullRequestNumber || run.phase !== 'verifying') return { kind: 'done', result: { skipped: run?.phase ?? 'missing' } };
  const tenant = await tenantFor(c.op, run.serviceId);
  const pr = await tenant.sourceControl.getPullRequest(tenant.repository.fullName, run.pullRequestNumber);

  const decision = await decideRecoveryWindow({
    repository: tenant.repository.fullName,
    pullRequest: pr,
    deployedAt: run.deployedAt,
    now: now(c),
    probe: () => probeDeployedRevision(tenant.service.healthUrl!, { allowPrivate: c.op.allowPrivateHealthUrl }),
    sourceControl: tenant.sourceControl,
  });
  if (decision.kind === 'wait') {
    if (decision.deployedAt && !run.deployedAt) await runs.update(run.id, { deployedAt: decision.deployedAt });
    return { kind: 'reschedule', at: new Date(now(c).getTime() + MERGE_POLL_MS), result: { waiting: decision.reason } };
  }

  const after = await workflowFor(c, tenant).completeAfterMerge({
    service: tenant.service.name,
    repository: tenant.repository.fullName,
    slackChannel: tenant.service.slackChannelId!,
    deployedRevision: run.deployedRevision,
    pullRequestNumber: pr.number,
    incidentKey: run.incidentKey ?? incidentKeyFor(run.deployedRevision),
    incidentId: run.incidentId,
    slackThread: { id: run.slackThreadTs!, channel: run.slackChannel! },
    issueKey: run.issueKey,
    alert: reviveAlert(run.alert),
    rootCause: run.rootCause ?? 'see the pull request',
    baselineWindow: range(run.baselineWindow),
    incidentWindow: range(run.incidentWindow),
    postRemediationWindow: decision.kind === 'ready' ? decision.window : { unavailable: decision.reason },
    ...(tenant.emailRecipients.length ? { teamEmails: tenant.emailRecipients } : {}),
  });
  await runs.update(run.id, {
    phase: 'settled',
    recoveryVerdict: after.recoveryVerdict,
    outcome: `recovery ${after.recoveryVerdict ?? 'unknown'}${after.writeUpUrl ? `, written up at ${after.writeUpUrl}` : ''}`,
  });
  return { kind: 'done', result: { verdict: after.recoveryVerdict } };
}

function iso(r: TimeRange): { from: string; to: string } {
  return { from: r.from.toISOString(), to: r.to.toISOString() };
}
function range(r: { from: string; to: string } | null): TimeRange {
  if (!r) throw new Error('the run has no recorded telemetry window');
  return { from: new Date(r.from), to: new Date(r.to) };
}
/** An alert read back from jsonb: its dates are strings again. */
function reviveAlert(raw: unknown): ProductionAlert {
  const a = raw as ProductionAlert & { firedAt: string };
  return {
    ...a,
    firedAt: new Date(a.firedAt),
    ...(a.primary
      ? { primary: { ...a.primary, firstSeen: new Date(a.primary.firstSeen as unknown as string), lastSeen: new Date(a.primary.lastSeen as unknown as string) } }
      : {}),
  };
}

export type { RevisionRunRow };
