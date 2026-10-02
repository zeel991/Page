/**
 * End to end, locally against the twins: every demo repository, from the alert to
 * an opened pull request.
 *
 *   pnpm demo:e2e
 *
 * Three repositories that differ in the ways that used to matter — a Node service
 * with no dependencies (INC-001), a Node service with real ones installed from a
 * lockfile (INC-021: express, supertest, vitest), and a Python service (INC-020:
 * pytest, a pinned requirements file) — each triggered by each alert source.
 *
 * Authorship is scripted (SCRIPTS in @pager/agents), so this costs nothing and runs
 * offline apart from the dependency installs, which need the package registries.
 * What it exercises is everything around authorship: detection, the clone, the
 * install, the two-run baseline, fail-before/pass-after, validation, the pull request.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DatadogProvider,
  GitHubAppTokenSource,
  GitHubProvider,
  JiraProvider,
  NotionProvider,
  PAGER_APP_MANIFEST,
  ResendProvider,
  SentryProvider,
  SlackProvider,
  registerViaManifest,
  type AlertSource,
  type DeploymentRecord,
  type ObservabilityProvider,
} from '@pager/providers';
import { AgentTracer, InMemorySink } from '@pager/observability';
import { IncidentWorkflow, SCRIPTS, ScriptedPatchGenerator } from '@pager/agents';
import { DirectoryDependencyCache, DockerRunner, type SandboxRunner } from '@pager/sandbox';
import { FIXTURES, LocalTwinServer, seedFromFixture, type ScenarioFixture } from '@pager/twin-local';

export type AlertSourceName = 'datadog' | 'sentry';
export const ALERT_SOURCES: readonly AlertSourceName[] = ['datadog', 'sentry'];
export const E2E_FIXTURES = ['INC-001', 'INC-021', 'INC-020'] as const;

export interface E2eRow {
  fixture: string;
  source: AlertSourceName;
  language: string;
  dependencies: string;
  baseline: string;
  reproduced: boolean;
  pullRequest: number | null;
  stage: string;
  haltReason: string | null;
  /** The end of the failing command's output, when a run stopped short. */
  output: string | null;
  seconds: number;
}

const SCENARIO_NOW = new Date('2026-09-13T15:10:00Z');

/**
 * Where repository code runs: on this host by default, or in the production sandbox
 * with PAGER_SANDBOX_RUNNER=docker and PAGER_SANDBOX_IMAGE (CI's sandbox-docker job).
 */
function sandboxRunnerFromEnv(): SandboxRunner | undefined {
  if (process.env.PAGER_SANDBOX_RUNNER !== 'docker') return undefined;
  const image = process.env.PAGER_SANDBOX_IMAGE?.trim();
  if (!image) throw new Error('PAGER_SANDBOX_RUNNER=docker needs PAGER_SANDBOX_IMAGE (build docker/sandbox.Dockerfile)');
  return new DockerRunner({ image });
}

/**
 * Metrics always come from the Datadog twin; what differs is where the incident is
 * noticed. With Sentry that is its issues and events — a real configuration, since
 * Sentry has no request metrics of ours.
 */
function providersFor(source: AlertSourceName, e: { datadog: string; sentry: string }): { observability: ObservabilityProvider; alerts: AlertSource } {
  const datadog = new DatadogProvider({ baseUrl: e.datadog });
  switch (source) {
    case 'datadog':
      return { observability: datadog, alerts: datadog };
    case 'sentry':
      return { observability: datadog, alerts: new SentryProvider({ baseUrl: e.sentry, token: 'sntrys_e2e', organization: 'acme', now: () => SCENARIO_NOW }) };
  }
}

export async function runOne(id: string, source: AlertSourceName, cacheDir: string): Promise<E2eRow> {
  const started = Date.now();
  const fixture: ScenarioFixture = FIXTURES[id]!;
  const script = SCRIPTS[id];
  if (!script) throw new Error(`no scripted fix for ${id}`);

  const sandboxRunner = sandboxRunnerFromEnv();
  const server = new LocalTwinServer({ now: () => Date.parse('2026-09-13T14:45:00Z') });
  server.seed(seedFromFixture(fixture));
  const e = await server.start();
  try {
    const creds = await registerViaManifest(e.github, PAGER_APP_MANIFEST(e.github));
    const tokens = new GitHubAppTokenSource(e.github, creds);
    const sourceControl = new GitHubProvider({ baseUrl: e.github, tokenProvider: () => tokens.token() });
    const workflow = new IncidentWorkflow({
      ...providersFor(source, e),
      sourceControl,
      messaging: new SlackProvider({ baseUrl: e.slack }),
      issueTracker: new JiraProvider({ baseUrl: e.jira, projectKey: 'INC' }),
      knowledge: new NotionProvider({ baseUrl: e.notion, token: 't', parentPageId: 'postmortems' }),
      email: new ResendProvider({ baseUrl: e.resend, apiKey: 're_t', from: 'pager@acme.dev' }),
      tracer: new AgentTracer({ sink: new InMemorySink(), lemma: null }),
      now: () => SCENARIO_NOW,
      patchGenerator: new ScriptedPatchGenerator(script),
      dependencyCache: new DirectoryDependencyCache(cacheDir),
      ...(sandboxRunner ? { sandboxRunner } : {}),
    });

    const tip = (await sourceControl.listCommits(fixture.repository, { limit: 1 }))[0]!;
    const head = await sourceControl.getCommit(fixture.repository, tip.sha);
    const deployment: DeploymentRecord = {
      id: `dep-${fixture.id}`,
      service: fixture.service,
      environment: 'production',
      commitSha: head.sha,
      previousCommitSha: head.parents[0] ?? null,
      status: 'succeeded',
      startedAt: new Date(Date.parse(fixture.deployedAt) - 120_000),
      deployedAt: new Date(fixture.deployedAt),
      author: head.authorName,
      repositoryFullName: fixture.repository,
    };
    const result = await workflow.run({
      service: fixture.service,
      repository: fixture.repository,
      slackChannel: '#incidents',
      incidentKey: `${fixture.id}-${source}`,
      deployment,
    });
    const b = result.suiteBaseline;
    return {
      fixture: id,
      source,
      language: fixture.repository === 'acme/billing-api' ? 'python' : 'node',
      dependencies: result.dependencies ? `${result.dependencies.status}${result.dependencies.plan ? ` (${result.dependencies.plan.manager})` : ''}` : 'n/a',
      baseline: !b ? 'n/a' : b.passed ? 'green ×2' : `red: ${b.failing.length} failing, ${b.flaky.length} flaky`,
      reproduced: result.reproduction?.proven ?? false,
      pullRequest: result.pullRequest?.number ?? null,
      stage: result.stage,
      haltReason: result.haltReason,
      output: result.pullRequest ? null : (result.reproduction?.afterFix ?? result.reproduction?.beforeFix)?.output.slice(-1500) ?? null,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    };
  } finally {
    await server.stop();
  }
}

async function main(): Promise<void> {
  const cacheDir = process.env.PAGER_DEPENDENCY_CACHE ?? join(tmpdir(), 'pager-e2e-dependency-cache');
  const rows: E2eRow[] = [];
  for (const id of E2E_FIXTURES) {
    for (const source of ALERT_SOURCES) {
      process.stdout.write(`${id} via ${source} … `);
      const row = await runOne(id, source, cacheDir);
      rows.push(row);
      console.log(row.pullRequest ? `PR #${row.pullRequest}` : `stopped at ${row.stage}: ${row.haltReason ?? ''}`);
      if (row.output) console.log(`--- output ---\n${row.output}\n--------------`);
    }
  }
  console.log('\n| fixture | language | alert source | dependencies | baseline | reproduced | pull request | seconds |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    console.log(`| ${r.fixture} | ${r.language} | ${r.source} | ${r.dependencies} | ${r.baseline} | ${r.reproduced ? 'yes' : 'no'} | ${r.pullRequest ? `#${r.pullRequest}` : '—'} | ${r.seconds} |`);
  }
  const failed = rows.filter((r) => !r.pullRequest);
  if (failed.length > 0) {
    console.error(`\n${failed.length} run(s) did not reach a pull request.`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
