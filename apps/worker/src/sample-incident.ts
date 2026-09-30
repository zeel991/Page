import {
  AgentRunRepository,
  AuditRepository,
  DrizzleTelemetrySink,
  EvidenceRepository,
  FixRepository,
  IncidentRepository,
  InvestigationRepository,
  TelemetryRepository,
  TimelineRepository,
  and,
  eq,
  incidentUnitOfWork,
  services,
  type Database,
  type JobRow,
} from '@pager/db';
import {
  DatadogProvider,
  GitHubAppTokenSource,
  GitHubProvider,
  PAGER_APP_MANIFEST,
  SlackProvider,
  registerViaManifest,
  type DeploymentRecord,
} from '@pager/providers';
import { AgentTracer } from '@pager/observability';
import { IncidentEngine, IncidentWorkflow, SCRIPTS, ScriptedPatchGenerator } from '@pager/agents';
import { INC_001, LocalTwinServer, seedFromFixture } from '@pager/twin-local';
import type { SandboxRunner } from '@pager/sandbox';

/**
 * "Send a test incident": the whole loop, for a workspace that has connected nothing.
 *
 * Runs the demo checkout-api incident against in-process twins of GitHub, Datadog and
 * Slack, with the scripted patch, and persists it into the workspace under a sample
 * service (alert source `sample`, never polled, never counted against the plan). The
 * incident is real in every way the console shows — timeline, evidence, reproduction
 * exit codes, the pull request on the twin — and labelled as a sample wherever it
 * appears. Nothing leaves this process.
 */

export const SAMPLE_SERVICE_NAME = 'sample-checkout-api';

async function sampleService(db: Database, organizationId: string): Promise<string> {
  const [existing] = await db
    .select()
    .from(services)
    .where(and(eq(services.organizationId, organizationId), eq(services.name, SAMPLE_SERVICE_NAME)))
    .limit(1);
  if (existing) return existing.id;
  const [row] = await db
    .insert(services)
    .values({ organizationId, name: SAMPLE_SERVICE_NAME, alertSource: 'sample', enabled: false, ownerTeam: 'sample (test incident)' })
    .returning();
  return row!.id;
}

export async function runSampleIncident(db: Database, job: JobRow, sandboxRunner: SandboxRunner) {
  const organizationId = job.organizationId;
  const serviceId = await sampleService(db, organizationId);
  // One clock for twin and workflow, fixed at the scenario's own afternoon.
  const now = () => new Date(Date.parse(INC_001.deployedAt) + 14 * 60_000);
  const twin = new LocalTwinServer({ now: () => now().getTime() });
  twin.seed(seedFromFixture(INC_001));
  const e = await twin.start();
  try {
    const creds = await registerViaManifest(e.github, PAGER_APP_MANIFEST(e.github));
    const tokens = new GitHubAppTokenSource(e.github, creds);
    const sourceControl = new GitHubProvider({ baseUrl: e.github, tokenProvider: () => tokens.token() });
    const incidents = new IncidentRepository(db);
    const tracer = new AgentTracer({ sink: new DrizzleTelemetrySink(db, { organizationId }), lemma: null });
    const workflow = new IncidentWorkflow({
      observability: new DatadogProvider({ baseUrl: e.datadog }),
      sourceControl,
      messaging: new SlackProvider({ baseUrl: e.slack }),
      issueTracker: null,
      knowledge: null,
      email: null,
      tracer,
      now,
      sandboxRunner,
      patchGenerator: new ScriptedPatchGenerator(SCRIPTS['INC-001']!),
      persistence: {
        engine: new IncidentEngine(incidents, new TimelineRepository(db), new AuditRepository(db), incidentUnitOfWork(db)),
        evidence: new EvidenceRepository(db),
        agentRuns: new AgentRunRepository(db),
        telemetry: new TelemetryRepository(db),
        investigations: new InvestigationRepository(db),
        fixes: new FixRepository(db),
        organizationId,
        serviceId,
      },
    });
    const tip = await sourceControl.listCommits(INC_001.repository, { limit: 1 });
    const head = await sourceControl.getCommit(INC_001.repository, tip[0]!.sha);
    const deployment: DeploymentRecord = {
      id: 'sample-deployment',
      service: INC_001.service,
      environment: 'production',
      commitSha: head.sha,
      previousCommitSha: head.parents[0] ?? null,
      status: 'succeeded',
      startedAt: new Date(Date.parse(INC_001.deployedAt) - 120_000),
      deployedAt: new Date(INC_001.deployedAt),
      author: head.authorName,
      repositoryFullName: INC_001.repository,
    };
    const result = await workflow.run({
      service: INC_001.service,
      repository: INC_001.repository,
      slackChannel: '#incidents',
      deployment,
    });
    return {
      incidentId: result.incident?.id ?? null,
      state: result.incident?.state ?? null,
      stage: result.stage,
      pullRequest: result.pullRequest?.number ?? null,
      halt: result.haltReason,
    };
  } finally {
    await twin.stop();
  }
}
