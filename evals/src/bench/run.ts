/**
 * The benchmark.
 *
 *   pnpm bench --repeat 3              every scenario, three trials each, scripted authorship
 *   pnpm bench --live --repeat 3       the same with the live model (costs money; run by hand)
 *   pnpm bench --subset ci             the deterministic subset CI runs
 *   pnpm bench --check                 validate the recipes themselves, without running the agent
 *   pnpm bench --subset ci --gate      exit non-zero if any trial has the wrong outcome (what CI runs)
 *   pnpm bench --only cart-off-by-one  one scenario
 *
 * Every scenario type repeats, abstentions included. A pull request is judged by a
 * hidden oracle test and the repository's own suite, run on a fresh clone of the
 * pull request's head — not by anything the run itself reports.
 *
 * "Scripted" means the regression test and the patch come from the recipe, as an
 * eager author that always proposes a fix would write them; what is measured then is
 * everything around authorship — detection, the gates, reproduction, validation — and
 * which false pull requests those stop on their own. "Live" means a model authored
 * them. The report says which, on every line.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IncidentInvestigator,
  IncidentWorkflow,
  ModelPatchGenerator,
  ScriptedPatchGenerator,
  describeModelAvailability,
  modelFromEnv,
  type PatchGenerator,
} from '@pager/agents';
import { AgentTracer, InMemorySink } from '@pager/observability';
import {
  DatadogProvider,
  GitHubAppTokenSource,
  GitHubProvider,
  NotionProvider,
  PAGER_APP_MANIFEST,
  SlackProvider,
  registerViaManifest,
  type DeploymentRecord,
  type SourceControlProvider,
} from '@pager/providers';
import { DirectoryDependencyCache, Sandbox, ValidationEngine, installDependencies, profileRepository, singleTestCommand } from '@pager/sandbox';
import { LocalTwinServer, seedFromFixture } from '@pager/twin-local';
import { BUGS, CI_SUBSET, CONTROLS } from './recipes.ts';
import { baseFiles, bugScenario, controlScenario, type BenchScenario } from './generate.ts';
import { median, passAtK, quantile, trialVariance, wilson, type Proportion } from './stats.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORTS = join(HERE, '..', '..', 'reports');
const DOCS = join(HERE, '..', '..', '..', 'docs');
const SCENARIO_NOW = new Date('2026-09-13T15:10:00Z');

type Mode = 'scripted' | 'live';

interface Trial {
  scenario: string;
  trial: number;
  mode: Mode;
  pullRequest: number | null;
  reproduced: boolean;
  stage: string;
  haltReason: string | null;
  /** The oracle and the suite on a fresh clone of the pull request; null when no PR was opened. */
  oraclePassed: boolean | null;
  suitePassed: boolean | null;
  fixed: boolean;
  /** The right outcome for the scenario: a fixing PR for a bug, no PR for a control. */
  correct: boolean;
  durationMs: number;
  toolCalls: number;
  modelCalls: number;
  costUsd: number | null;
  error: string | null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(`--${name}`);
  const value = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const repeat = Math.max(1, Number(value('repeat') ?? 3));
  const mode: Mode = flag('live') ? 'live' : 'scripted';
  const only = value('only')?.split(',') ?? (value('subset') === 'ci' ? CI_SUBSET : null);
  const cacheDir = process.env.PAGER_DEPENDENCY_CACHE ?? join(tmpdir(), 'pager-bench-dependency-cache');
  const cache = new DirectoryDependencyCache(cacheDir);

  const wanted = <T extends { id: string }>(xs: T[]) => (only ? xs.filter((x) => only.includes(x.id)) : xs);
  const scenarios: BenchScenario[] = [];
  for (const bug of wanted(BUGS)) scenarios.push(await bugScenario(bug));
  for (const control of wanted(CONTROLS)) scenarios.push(await controlScenario(control));
  console.log(`${scenarios.length} scenario(s): ${scenarios.filter((s) => s.kind === 'bug').length} bugs, ${scenarios.filter((s) => s.kind === 'control').length} negative controls`);

  if (flag('check')) {
    process.exitCode = (await checkRecipes(scenarios, cache)) ? 0 : 1;
    return;
  }

  const availability = describeModelAvailability();
  if (mode === 'live' && !availability.available) {
    console.error(`--live needs a model: ${availability.reason}`);
    process.exitCode = 1;
    return;
  }

  const trials: Trial[] = [];
  for (const scenario of scenarios) {
    for (let t = 1; t <= repeat; t++) {
      const trial = await runTrial(scenario, t, mode, cache);
      trials.push(trial);
      console.log(
        `${scenario.id.padEnd(24)} #${t}  ${trial.correct ? 'ok  ' : 'MISS'}  ` +
          (trial.pullRequest ? `PR #${trial.pullRequest} oracle=${trial.oraclePassed} suite=${trial.suitePassed}` : `no PR (${trial.stage}${trial.haltReason ? `: ${trial.haltReason.slice(0, 90)}` : ''})`) +
          (trial.error ? ` ERROR ${trial.error.slice(0, 120)}` : ''),
      );
    }
  }

  const report = buildReport(scenarios, trials, { mode, repeat, model: mode === 'live' ? availability.model : null, subset: only });
  const date = new Date().toISOString().slice(0, 10);
  await mkdir(REPORTS, { recursive: true });
  // A partial run gets its own file, so it never replaces the full run's report.
  const suffix = only ? (value('subset') ? `-subset-${value('subset')}` : '-partial') : '';
  const jsonPath = join(REPORTS, `benchmark-${date}${suffix}.json`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  if (!only) {
    await mkdir(DOCS, { recursive: true });
    await writeFile(join(DOCS, 'benchmark.md'), renderMarkdown(report, `evals/reports/benchmark-${date}.json`, await earlierRuns()));
  }
  console.log(`\n${renderHeadline(report)}\nWrote ${jsonPath}${only ? '' : ' and docs/benchmark.md'}`);
  if (flag('gate')) {
    const wrong = trials.filter((t) => !t.correct);
    if (wrong.length > 0) {
      console.error(`\n${wrong.length} trial(s) had the wrong outcome: ${[...new Set(wrong.map((t) => t.scenario))].join(', ')}`);
      process.exitCode = 1;
    }
  }
}

async function runTrial(scenario: BenchScenario, trial: number, mode: Mode, cache: DirectoryDependencyCache): Promise<Trial> {
  const started = Date.now();
  const server = new LocalTwinServer({ now: () => Date.parse('2026-09-13T14:45:00Z') });
  server.seed(seedFromFixture(scenario.fixture));
  const e = await server.start();
  const base: Omit<Trial, 'pullRequest' | 'reproduced' | 'stage' | 'haltReason' | 'oraclePassed' | 'suitePassed' | 'fixed' | 'correct' | 'durationMs' | 'toolCalls' | 'modelCalls' | 'costUsd' | 'error'> = {
    scenario: scenario.id,
    trial,
    mode,
  };
  const sink = new InMemorySink();
  try {
    const creds = await registerViaManifest(e.github, PAGER_APP_MANIFEST(e.github));
    const tokens = new GitHubAppTokenSource(e.github, creds);
    const sourceControl = new GitHubProvider({ baseUrl: e.github, tokenProvider: () => tokens.token() });
    const observability = new DatadogProvider({ baseUrl: e.datadog });
    const knowledge = new NotionProvider({ baseUrl: e.notion, token: 't', parentPageId: 'postmortems' });
    const tracer = new AgentTracer({ sink, lemma: null });

    let patchGenerator: PatchGenerator;
    let investigator: IncidentInvestigator | null = null;
    let modelGenerator: ModelPatchGenerator | null = null;
    if (mode === 'live') {
      const model = modelFromEnv()!;
      modelGenerator = new ModelPatchGenerator({ model, tracer });
      patchGenerator = modelGenerator;
      investigator = new IncidentInvestigator({ model, tracer, providers: { observability, sourceControl, knowledge } });
    } else {
      patchGenerator = new ScriptedPatchGenerator(scenario.script);
    }

    const workflow = new IncidentWorkflow({
      observability,
      sourceControl,
      messaging: new SlackProvider({ baseUrl: e.slack }),
      issueTracker: null,
      knowledge,
      email: null,
      tracer,
      now: () => SCENARIO_NOW,
      patchGenerator,
      investigator,
      dependencyCache: cache,
    });
    const tip = (await sourceControl.listCommits(scenario.fixture.repository, { limit: 1 }))[0]!;
    const head = await sourceControl.getCommit(scenario.fixture.repository, tip.sha);
    const deployment: DeploymentRecord = {
      id: `dep-${scenario.id}`,
      service: scenario.fixture.service,
      environment: 'production',
      commitSha: head.sha,
      previousCommitSha: head.parents[0] ?? null,
      status: 'succeeded',
      startedAt: new Date(Date.parse(scenario.fixture.deployedAt) - 120_000),
      deployedAt: new Date(scenario.fixture.deployedAt),
      author: head.authorName,
      repositoryFullName: scenario.fixture.repository,
    };
    const result = await workflow.run({
      service: scenario.fixture.service,
      repository: scenario.fixture.repository,
      slackChannel: '#incidents',
      incidentKey: `BENCH-${scenario.id}-${trial}`,
      deployment,
    });
    const durationMs = Date.now() - started;
    const pr = result.pullRequest;
    let oraclePassed: boolean | null = null;
    let suitePassed: boolean | null = null;
    if (pr) {
      const verdict = await judge(scenario, sourceControl, pr.headSha, cache);
      oraclePassed = verdict.oraclePassed;
      suitePassed = verdict.suitePassed;
    }
    const fixed = Boolean(pr) && oraclePassed === true && suitePassed === true;
    const usage = [modelGenerator?.usage() ?? null, result.investigation ?? null].filter(Boolean) as { costUsd?: number | null; calls?: number }[];
    return {
      ...base,
      pullRequest: pr?.number ?? null,
      reproduced: result.reproduction?.proven ?? false,
      stage: result.stage,
      haltReason: result.haltReason,
      oraclePassed,
      suitePassed,
      fixed,
      correct: scenario.expectPullRequest ? fixed : !pr,
      durationMs,
      toolCalls: sink.toolCalls.length,
      modelCalls: mode === 'live' ? usage.reduce((n, u) => n + (u.calls ?? 0), 0) : 0,
      costUsd: mode === 'live' ? sumCost(usage) : null,
      error: null,
    };
  } catch (err) {
    return {
      ...base,
      pullRequest: null,
      reproduced: false,
      stage: 'error',
      haltReason: null,
      oraclePassed: null,
      suitePassed: null,
      fixed: false,
      correct: false,
      durationMs: Date.now() - started,
      toolCalls: sink.toolCalls.length,
      modelCalls: 0,
      costUsd: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await server.stop();
  }
}

function sumCost(usage: { costUsd?: number | null }[]): number | null {
  const costs = usage.map((u) => u.costUsd);
  return costs.some((c) => c === null || c === undefined) ? null : (costs as number[]).reduce((a, b) => a + b, 0);
}

/**
 * The verdict on a pull request: a fresh clone of its head, the hidden oracle run
 * on its own, then the repository's whole suite (oracle included).
 */
async function judge(scenario: BenchScenario, sourceControl: SourceControlProvider, headSha: string, cache: DirectoryDependencyCache) {
  if (!scenario.oracle) return { oraclePassed: null, suitePassed: null };
  const sandbox = await Sandbox.create(sourceControl, scenario.fixture.repository, headSha);
  try {
    const profile = await profileRepository(sandbox);
    await installDependencies(sandbox, profile, { cache });
    const validation = new ValidationEngine(sandbox);
    await sandbox.writeFile(scenario.oracle.path, scenario.oracle.source);
    const oracle = await validation.runCheck('test', singleTestCommand(profile, scenario.oracle.path) ?? profile.testCommand);
    const suite = await validation.runCheck('test', profile.testCommand);
    return { oraclePassed: oracle.passed, suitePassed: suite.passed };
  } finally {
    await sandbox.dispose();
  }
}

/** Every recipe must be a real bug: the suite passes with it, the oracle fails with it and passes without it. */
async function checkRecipes(scenarios: BenchScenario[], cache: DirectoryDependencyCache): Promise<boolean> {
  let ok = true;
  for (const s of scenarios.filter((x) => x.kind === 'bug')) {
    const clean = await baseFiles(s.repo);
    const deployed = s.fixture.commits.at(-1)!.changes;
    const buggy = { ...clean, ...Object.fromEntries(deployed.map((c) => [c.path, c.content!])) };
    const verdict = async (files: Record<string, string>, withOracle: boolean) => {
      const sandbox = await Sandbox.fromFiles(withOracle ? { ...files, [s.oracle!.path]: s.oracle!.source } : files, 'check');
      try {
        const profile = await profileRepository(sandbox);
        await installDependencies(sandbox, profile, { cache });
        const v = new ValidationEngine(sandbox);
        return withOracle
          ? (await v.runCheck('test', singleTestCommand(profile, s.oracle!.path) ?? profile.testCommand)).passed
          : (await v.runCheck('test', profile.testCommand)).passed;
      } finally {
        await sandbox.dispose();
      }
    };
    const suiteWithBug = await verdict(buggy, false);
    const oracleWithBug = await verdict(buggy, true);
    const oracleClean = await verdict(clean, true);
    const good = suiteWithBug && !oracleWithBug && oracleClean;
    if (!good) ok = false;
    console.log(`${good ? 'ok  ' : 'BAD '} ${s.id.padEnd(24)} suite-with-bug=${suiteWithBug} oracle-with-bug=${oracleWithBug} oracle-clean=${oracleClean}  ${s.failure.errorType}: ${s.failure.message.slice(0, 60)}`);
  }
  return ok;
}

// ── The report ──────────────────────────────────────────────────────────────

export interface BenchmarkReport {
  generatedAt: string;
  mode: Mode;
  model: string | null;
  repeat: number;
  subset: string[] | null;
  scenarios: { id: string; kind: 'bug' | 'control'; type: string; repository: string; language: string; expectPullRequest: boolean; failure: { errorType: string; message: string }; why: string }[];
  trials: Trial[];
  metrics: {
    fixRate: Proportion;
    falsePullRequests: Proportion & { onControls: number; failingOracle: number };
    abstentionPrecision: Proportion;
    abstentionRecall: Proportion;
    reproductionRate: Proportion;
    timeToPrSeconds: { median: number | null; p90: number | null };
    costPerIncidentUsd: { median: number | null; note: string };
    toolCallsPerIncident: { median: number | null; mean: number | null };
    passAtK: Proportion & { k: number };
    variance: { meanVariance: number | null; inconsistentScenarios: number; scenarios: number };
    errors: number;
  };
  byType: { kind: 'bug' | 'control'; type: string; correct: Proportion }[];
  caveats: string[];
}

function buildReport(scenarios: BenchScenario[], trials: Trial[], meta: { mode: Mode; repeat: number; model: string | null; subset: string[] | null }): BenchmarkReport {
  const kindOf = new Map(scenarios.map((s) => [s.id, s.kind]));
  const bug = trials.filter((t) => kindOf.get(t.scenario) === 'bug');
  const control = trials.filter((t) => kindOf.get(t.scenario) === 'control');
  const withPr = trials.filter((t) => t.pullRequest !== null);
  const abstained = trials.filter((t) => t.pullRequest === null);
  const onControls = control.filter((t) => t.pullRequest !== null).length;
  const failingOracle = bug.filter((t) => t.pullRequest !== null && !t.fixed).length;
  const perScenario = (kind: 'bug' | 'control', pick: (t: Trial) => boolean) =>
    scenarios.filter((s) => s.kind === kind).map((s) => trials.filter((t) => t.scenario === s.id).map(pick));
  const toolCalls = trials.map((t) => t.toolCalls);
  const costs = trials.map((t) => t.costUsd).filter((c): c is number => c !== null);
  const types = [...new Set(scenarios.map((s) => `${s.kind}:${s.type}`))];

  return {
    generatedAt: new Date().toISOString(),
    mode: meta.mode,
    model: meta.model,
    repeat: meta.repeat,
    subset: meta.subset,
    scenarios: scenarios.map((s) => ({ id: s.id, kind: s.kind, type: s.type, repository: s.repo.repository, language: s.repo.language, expectPullRequest: s.expectPullRequest, failure: s.failure, why: s.why })),
    trials,
    metrics: {
      fixRate: wilson(bug.filter((t) => t.fixed).length, bug.length),
      falsePullRequests: { ...wilson(onControls + failingOracle, withPr.length), onControls, failingOracle },
      abstentionPrecision: wilson(abstained.filter((t) => kindOf.get(t.scenario) === 'control').length, abstained.length),
      abstentionRecall: wilson(control.filter((t) => t.pullRequest === null).length, control.length),
      reproductionRate: wilson(bug.filter((t) => t.reproduced).length, bug.length),
      timeToPrSeconds: {
        median: nullableSeconds(median(withPr.map((t) => t.durationMs))),
        p90: nullableSeconds(quantile(withPr.map((t) => t.durationMs), 0.9)),
      },
      costPerIncidentUsd: {
        median: meta.mode === 'live' ? median(costs) : null,
        note: meta.mode === 'live' ? `${costs.length} of ${trials.length} trials priced` : 'scripted authorship: no model calls, so no model cost',
      },
      toolCallsPerIncident: { median: median(toolCalls), mean: toolCalls.length ? toolCalls.reduce((a, b) => a + b, 0) / toolCalls.length : null },
      passAtK: { ...passAtK(perScenario('bug', (t) => t.fixed)), k: meta.repeat },
      variance: trialVariance([...perScenario('bug', (t) => t.fixed), ...perScenario('control', (t) => t.correct)]),
      errors: trials.filter((t) => t.error).length,
    },
    byType: types.map((key) => {
      const [kind, type] = key.split(':') as ['bug' | 'control', string];
      const ids = new Set(scenarios.filter((s) => s.kind === kind && s.type === type).map((s) => s.id));
      const ts = trials.filter((t) => ids.has(t.scenario));
      return { kind, type, correct: wilson(ts.filter((t) => t.correct).length, ts.length) };
    }),
    caveats: [
      meta.mode === 'scripted'
        ? 'Scripted authorship: every regression test and patch came from the recipe, as an eager author would write them. These numbers measure detection and the deterministic gates, not a model. A live run (--live) measures the model; none is reported here.'
        : `Live authorship with ${meta.model}.`,
      'Local twins throughout (GitHub, Datadog, Slack, Notion); the repositories are small benchmark services under evals/bench/repos.',
      'Telemetry is synthetic but its failures are real: each is what the buggy code actually threw when run with the recipe’s trigger.',
      meta.repeat > 1 && meta.mode === 'scripted' ? 'Scripted trials are deterministic, so repeats measure run-to-run stability of the pipeline, not model variance.' : '',
    ].filter(Boolean),
  };
}

const nullableSeconds = (ms: number | null) => (ms === null ? null : Math.round(ms / 100) / 10);
const pct = (p: Proportion) => (p.rate === null ? 'n/a' : `${(p.rate * 100).toFixed(0)}% (${p.successes}/${p.trials}; 95% CI ${(p.ci95![0] * 100).toFixed(0)}–${(p.ci95![1] * 100).toFixed(0)}%)`);

function renderHeadline(r: BenchmarkReport): string {
  const m = r.metrics;
  return [
    `| metric | value |`,
    `| --- | --- |`,
    `| fix rate (oracle passes and suite green) | ${pct(m.fixRate)} |`,
    `| false pull requests (on a control, or failing the oracle) | ${pct(m.falsePullRequests)} — ${m.falsePullRequests.onControls} on controls, ${m.falsePullRequests.failingOracle} failing the oracle |`,
    `| abstention precision | ${pct(m.abstentionPrecision)} |`,
    `| abstention recall | ${pct(m.abstentionRecall)} |`,
    `| reproduction rate | ${pct(m.reproductionRate)} |`,
    `| time to pull request, median / p90 | ${m.timeToPrSeconds.median ?? 'n/a'} s / ${m.timeToPrSeconds.p90 ?? 'n/a'} s |`,
    `| model cost per incident, median | ${m.costPerIncidentUsd.median === null ? `n/a (${m.costPerIncidentUsd.note})` : `$${m.costPerIncidentUsd.median.toFixed(2)}`} |`,
    `| tool calls per incident, median | ${m.toolCallsPerIncident.median ?? 'n/a'} |`,
    `| pass@${m.passAtK.k} | ${pct(m.passAtK)} |`,
    `| scenarios with inconsistent outcomes across trials | ${m.variance.inconsistentScenarios} of ${m.variance.scenarios} (mean variance ${m.variance.meanVariance?.toFixed(3) ?? 'n/a'}) |`,
  ].join('\n');
}

/** Kept runs from before a fix, so what the benchmark caught stays on record beside what it now reports. */
async function earlierRuns(): Promise<{ file: string; report: BenchmarkReport }[]> {
  const files = (await readdir(REPORTS).catch(() => [] as string[])).filter((f) => f.endsWith('-before-fixes.json')).sort();
  return Promise.all(files.map(async (file) => ({ file, report: JSON.parse(await readFile(join(REPORTS, file), 'utf8')) as BenchmarkReport })));
}

function renderEarlier(runs: { file: string; report: BenchmarkReport }[]): string[] {
  if (runs.length === 0) return [];
  const out = ['## What earlier runs caught', ''];
  for (const { file, report } of runs) {
    const wrong = report.trials.filter((t) => !t.correct);
    out.push(
      `\`evals/reports/${file}\` (${report.mode}, ${report.repeat} trial(s)): fix rate ${pct(report.metrics.fixRate)}, ` +
        `${report.metrics.falsePullRequests.onControls} pull request(s) on negative controls. Wrong outcomes:`,
      '',
      ...wrong.map((t) => `- ${t.scenario}: ${t.pullRequest ? `opened PR #${t.pullRequest}` : `no PR — ${t.haltReason?.slice(0, 140) ?? t.stage}`}`),
      '',
    );
  }
  out.push('Each was a defect in the pipeline, fixed with a test that failed before the fix; the run above is after them.', '');
  return out;
}

function renderMarkdown(r: BenchmarkReport, jsonPath: string, earlier: { file: string; report: BenchmarkReport }[] = []): string {
  const bugs = r.scenarios.filter((s) => s.kind === 'bug');
  const controls = r.scenarios.filter((s) => s.kind === 'control');
  const repos = [...new Set(r.scenarios.map((s) => `${s.repository} (${s.language})`))];
  const rows = r.scenarios.map((s) => {
    const ts = r.trials.filter((t) => t.scenario === s.id);
    const outcome = ts.map((t) => (t.pullRequest ? (t.fixed ? 'fixed' : 'PR, not fixed') : 'no PR')).join(', ');
    return `| ${s.id} | ${s.kind} | ${s.type.replace(/_/g, ' ')} | ${s.language} | ${s.expectPullRequest ? 'fix' : 'abstain'} | ${ts.filter((t) => t.correct).length}/${ts.length} | ${outcome} |`;
  });
  return [
    '# Benchmark',
    '',
    `Generated by \`pnpm bench --repeat ${r.repeat}${r.mode === 'live' ? ' --live' : ''}\` on ${r.generatedAt.slice(0, 10)}. Raw results: \`${jsonPath}\`. Do not edit by hand.`,
    '',
    `**Authorship: ${r.mode === 'scripted' ? 'scripted — no model was called' : `live model (${r.model})`}.** ${r.caveats[0]}`,
    '',
    `${r.scenarios.length} scenarios — ${bugs.length} bugs and ${controls.length} negative controls — across ${repos.length} repositories (${repos.join(', ')}), ${r.repeat} trial(s) each: ${r.trials.length} trials. Intervals are Wilson 95%.`,
    '',
    renderHeadline(r),
    '',
    '## By kind',
    '',
    '| kind | type | correct |',
    '| --- | --- | --- |',
    ...r.byType.map((b) => `| ${b.kind} | ${b.type.replace(/_/g, ' ')} | ${pct(b.correct)} |`),
    '',
    '## Scenarios',
    '',
    '| scenario | kind | type | language | right outcome | correct | trials |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    ...renderEarlier(earlier),
    '## How it is measured',
    '',
    '- **Scenarios.** Each bug is a recipe applied to a clean base repository (`evals/bench/repos`) as the deployment commit. Its telemetry is what the buggy code actually throws when run with the recipe’s trigger, logged with production paths. Each negative control is a situation where the right action is to open no pull request: the error was already happening before the deploy; the telemetry is hours stale; the cause is a downstream 503 inside a client library; the only “reproduction” is a flaky test.',
    '- **Fixed** means a fresh clone of the pull request’s head passes a hidden oracle test that no part of the run could see, and the repository’s whole suite.',
    '- **False pull request** is a pull request opened on a negative control, or one that does not pass the oracle; the rate is over pull requests opened.',
    '- **Abstention precision** is the share of runs that opened no pull request which were controls; **recall** is the share of control runs that opened none.',
    '- **pass@k** is the share of bug scenarios fixed in at least one of their k trials.',
    '',
    '## Caveats',
    '',
    ...r.caveats.map((c) => `- ${c}`),
    '',
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
