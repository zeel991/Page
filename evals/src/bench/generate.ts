import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { SeedScript } from '@pager/agents';
import type { LogFixture, MetricFixture, ScenarioFixture } from '@pager/twin-local';
import { BUGS, REPOS, type BugRecipe, type BugType, type ControlRecipe, type ControlType, type RepoSpec, type TestFile } from './recipes.ts';

/**
 * Builds a benchmark scenario from a clean base repository and a recipe.
 *
 * The fixture carries the bug as a commit (the deployment), telemetry shaped like
 * what the backend would show, and nothing else. The failure in that telemetry is
 * not written by hand: the buggy code is run with the recipe's trigger and what it
 * really throws — message, type, stack — is recorded, with paths rewritten to where
 * the service runs in production.
 */

const run = promisify(execFile);
export const REPOS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bench', 'repos');
const SKIP = new Set(['node_modules', '.venv', '__pycache__', '.pytest_cache', '.git', '.DS_Store']);

export interface BenchScenario {
  id: string;
  kind: 'bug' | 'control';
  type: BugType | ControlType;
  repo: RepoSpec;
  fixture: ScenarioFixture;
  /** What the scripted author proposes. */
  script: SeedScript;
  /** Hidden: decides whether a pull request really fixes the bug. Null for controls. */
  oracle: TestFile | null;
  /** The right outcome: a pull request, or none (abstain). */
  expectPullRequest: boolean;
  why: string;
  /** The failure the telemetry reports, for the report. */
  failure: { errorType: string; message: string };
}

async function walk(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if ((await stat(full)).isDirectory()) out.push(...(await walk(root, full)));
    else out.push(relative(root, full).split(sep).join('/'));
  }
  return out.sort();
}

export async function baseFiles(repo: RepoSpec): Promise<Record<string, string>> {
  const root = join(REPOS_ROOT, repo.id);
  const files: Record<string, string> = {};
  for (const path of await walk(root)) files[path] = await readFile(join(root, path), 'utf8');
  return files;
}

function applyBug(files: Record<string, string>, bug: BugRecipe): Record<string, string> {
  const before = files[bug.file];
  if (before === undefined) throw new Error(`${bug.id}: ${bug.file} is not in ${bug.repo}`);
  const count = before.split(bug.find).length - 1;
  if (count !== 1) throw new Error(`${bug.id}: expected the snippet exactly once in ${bug.file}, found ${count}`);
  return { ...files, [bug.file]: before.replace(bug.find, bug.replace) };
}

/** Run the trigger against these files and record what is thrown. */
export async function captureFailure(repo: RepoSpec, files: Record<string, string>, trigger: string): Promise<{ errorType: string; message: string; stack: string }> {
  const dir = await mkdtemp(join(tmpdir(), `pager-bench-${repo.id}-`));
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    let out: string;
    if (repo.language === 'python') {
      const script = [
        'import json, sys, traceback',
        `sys.path.insert(0, ${JSON.stringify(dir)})`,
        'from billing.api import summarize',
        'try:',
        `    summarize(${trigger})`,
        '    print("__OK__")',
        'except Exception as e:',
        '    print("__ERR__" + json.dumps({"name": type(e).__name__, "message": str(e), "stack": traceback.format_exc()}))',
      ].join('\n');
      out = (await run('python3', ['-c', script], { timeout: 30_000 })).stdout;
    } else {
      const entry = pathToFileURL(join(dir, repo.entry)).href;
      const script =
        `const m = await import(${JSON.stringify(entry)});` +
        `try { await (async function handleRequest() { return await (${trigger}); })(); console.log('__OK__'); }` +
        `catch (e) { console.log('__ERR__' + JSON.stringify({ name: e.name, message: e.message, stack: e.stack })); }`;
      out = (await run('node', ['--no-warnings', '--input-type=module', '-e', script], { timeout: 30_000 })).stdout;
    }
    const line = out.split('\n').find((l) => l.startsWith('__ERR__'));
    if (!line) throw new Error(`the trigger did not fail against the buggy ${repo.id}: ${out.trim()}`);
    const { name, message, stack } = JSON.parse(line.slice('__ERR__'.length)) as { name: string; message: string; stack: string };
    return { errorType: name, message, stack: productionStack(repo, dir, stack) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The stack as the running service would log it: its own paths, no harness frames. */
function productionStack(repo: RepoSpec, dir: string, stack: string): string {
  // macOS reports the temp directory by its real path, under /private.
  let text = stack;
  for (const root of [`/private${dir}`, dir]) text = text.split(`file://${root}`).join(`file://${repo.deployRoot}`).split(root).join(repo.deployRoot);
  const lines = text.split('\n');
  if (repo.language === 'python') {
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes('File "<string>"')) {
        if (lines[i + 1] && !lines[i + 1]!.trimStart().startsWith('File ')) i++;
        continue;
      }
      kept.push(lines[i]!);
    }
    // The web framework's frame, as a real server's traceback would begin.
    const at = kept.findIndex((l) => l.startsWith('Traceback'));
    kept.splice(at + 1, 0, '  File "/usr/local/lib/python3.12/site-packages/flask/app.py", line 1473, in wsgi_app', '    response = self.full_dispatch_request()');
    return kept.join('\n').trimEnd();
  }
  return [
    ...lines.filter((l) => !l.includes('[eval')),
    '    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)',
    '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
  ].join('\n');
}

const iso = (base: string, minutes: number) => new Date(Date.parse(base) + minutes * 60_000).toISOString();

function metrics(service: string, errorBaseline: number, errorAfter: number): MetricFixture[] {
  return [
    { service, metric: 'error_rate', unit: 'ratio', baseline: errorBaseline, after: errorAfter, jitter: 0.08 },
    { service, metric: 'http_5xx_rate', unit: 'ratio', baseline: errorBaseline * 0.9, after: errorAfter * 0.97, jitter: 0.08 },
    { service, metric: 'latency_p95', unit: 'ms', baseline: 160, after: 163, jitter: 0.04 },
    { service, metric: 'latency_p50', unit: 'ms', baseline: 52, after: 52, jitter: 0.04 },
    { service, metric: 'request_throughput', unit: 'requests/s', baseline: 200, after: 197, jitter: 0.03 },
    { service, metric: 'availability', unit: 'ratio', baseline: 0.9997, after: 0.9995, jitter: 0.0002 },
  ];
}

const RUNBOOK = (service: string) => ({
  id: `runbook-${service}`,
  title: `Runbook: ${service}`,
  content: `# Runbook: ${service}\n\n## Known failure modes\n\n- Database failovers surface as ConnectionResetError from \`src/db.ts\`, with 503s upstream; they clear on their own.\n\n## Rollback\n\nRedeploy the previous release tag.`,
});

const README = (service: string) => `# ${service}\n\nSee the runbook for operational guidance. Deployed by CI on every merge to main.\n`;

interface Timeline {
  deployedAt: string;
  windowFrom: string;
  windowTo: string;
}
const NORMAL: Timeline = { deployedAt: '2026-09-13T14:31:00Z', windowFrom: '2026-09-13T14:00:00Z', windowTo: '2026-09-13T15:00:00Z' };
// Four hours earlier: the errors and the monitor's transition are all this old.
const STALE: Timeline = { deployedAt: '2026-09-13T10:31:00Z', windowFrom: '2026-09-13T10:00:00Z', windowTo: '2026-09-13T11:00:00Z' };

function fixtureFor(opts: {
  id: string;
  repo: RepoSpec;
  initial: Record<string, string>;
  deploy: { message: string; changes: Record<string, string> };
  failure: { message: string; stack: string };
  timeline: Timeline;
  errorsFrom: string;
  errorCount: number;
  errorInterval: number;
  monitorAt: string;
  errorRate: { baseline: number; after: number };
}): ScenarioFixture {
  const { repo, timeline } = opts;
  const logs: LogFixture[] = [
    {
      service: repo.service,
      level: 'error',
      message: opts.failure.message,
      stack: opts.failure.stack,
      from: opts.errorsFrom,
      count: opts.errorCount,
      intervalSeconds: opts.errorInterval,
      attributes: { 'http.route': repo.route, 'http.status_code': 500 },
    },
    { service: repo.service, level: 'info', message: 'request completed', from: iso(timeline.windowFrom, 5), count: 12, intervalSeconds: 120 },
  ];
  return {
    id: opts.id,
    repository: repo.repository,
    service: repo.service,
    defaultBranch: 'main',
    description: `${repo.service} (${repo.language})`,
    windowFrom: timeline.windowFrom,
    windowTo: timeline.windowTo,
    deployedAt: timeline.deployedAt,
    commits: [
      { message: 'Initial import', author: 'Priya', at: '2026-09-10T09:00:00Z', branch: 'main', changes: Object.entries(opts.initial).map(([path, content]) => ({ path, content })) },
      { message: opts.deploy.message, author: 'Dana', at: iso(timeline.deployedAt, -11), branch: 'main', changes: Object.entries(opts.deploy.changes).map(([path, content]) => ({ path, content })) },
    ],
    metrics: metrics(repo.service, opts.errorRate.baseline, opts.errorRate.after),
    logs,
    monitors: [
      {
        name: `${repo.service} error rate`,
        service: repo.service,
        query: `avg(last_5m):sum:trace.http.request.errors{service:${repo.service}}.as_rate() > 0.05`,
        state: 'Alert',
        transitionedAt: opts.monitorAt,
      },
    ],
    slackChannels: ['#incidents'],
    pages: [RUNBOOK(repo.service)],
  };
}

/** How a runtime logs the failure: Node prints "Type: message"; a Python logger prints its own text and the traceback. */
function logged(repo: RepoSpec, f: { errorType: string; message: string; stack: string }): { message: string; stack: string } {
  if (repo.language === 'python') return { message: `${repo.route} failed`, stack: f.stack };
  return { message: `${f.errorType}: ${f.message}`, stack: f.stack };
}

function fixScript(bug: BugRecipe, clean: Record<string, string>, test: BugRecipe['test']): SeedScript {
  return {
    regressionTest: { path: test.path, source: test.source, expectedFailureMarkers: test.markers, expectedFailureDescription: test.description },
    patch: {
      rootCause: `${bug.commit} introduced a ${bug.type.replace(/_/g, ' ')} in ${bug.file}.`,
      explanation: `Restore the behaviour ${bug.file} had before "${bug.commit}".`,
      files: [{ path: bug.file, content: clean[bug.file]! }],
      risks: [],
      rollbackPlan: 'Revert the merge commit.',
      confidence: 0.9,
    },
  };
}

export async function bugScenario(bug: BugRecipe): Promise<BenchScenario> {
  const repo = REPOS[bug.repo];
  const clean = await baseFiles(repo);
  const buggy = applyBug(clean, bug);
  const failure = await captureFailure(repo, buggy, bug.trigger);
  const fixture = fixtureFor({
    id: bug.id,
    repo,
    initial: clean,
    deploy: { message: bug.commit, changes: { [bug.file]: buggy[bug.file]! } },
    failure: logged(repo, failure),
    timeline: NORMAL,
    errorsFrom: iso(NORMAL.deployedAt, 1),
    errorCount: 20,
    errorInterval: 45,
    monitorAt: iso(NORMAL.deployedAt, 3),
    errorRate: { baseline: 0.003, after: 0.14 },
  });
  return {
    id: bug.id,
    kind: 'bug',
    type: bug.type,
    repo,
    fixture,
    script: fixScript(bug, clean, bug.test),
    oracle: bug.oracle,
    expectPullRequest: true,
    why: `"${bug.commit}" ships a ${bug.type.replace(/_/g, ' ')} in ${bug.file}.`,
    failure: { errorType: failure.errorType, message: failure.message },
  };
}

export async function controlScenario(control: ControlRecipe): Promise<BenchScenario> {
  const repo = REPOS[control.repo];
  const clean = await baseFiles(repo);
  const readme = { 'README.md': README(repo.service) };
  const base = {
    id: control.id,
    kind: 'control' as const,
    type: control.type,
    repo,
    oracle: null,
    expectPullRequest: false,
    why: control.why,
  };

  if (control.type === 'error_predates_deploy' || control.type === 'stale_telemetry') {
    const bug = BUGS.find((b) => b.id === control.bug)!;
    const buggy = applyBug(clean, bug);
    const failure = await captureFailure(repo, buggy, bug.trigger);
    const predates = control.type === 'error_predates_deploy';
    const timeline = predates ? NORMAL : STALE;
    const fixture = fixtureFor({
      id: control.id,
      repo,
      // Already broken before the deploy, which touches only the README; or a real
      // bug whose errors are all four hours old.
      initial: predates ? buggy : clean,
      deploy: predates ? { message: 'Update the README', changes: readme } : { message: bug.commit, changes: { [bug.file]: buggy[bug.file]! } },
      failure: logged(repo, failure),
      timeline,
      errorsFrom: predates ? iso(timeline.deployedAt, -70) : iso(timeline.deployedAt, 1),
      errorCount: predates ? 40 : 20,
      errorInterval: predates ? 180 : 45,
      monitorAt: predates ? iso(timeline.deployedAt, -65) : iso(timeline.deployedAt, 3),
      errorRate: predates ? { baseline: 0.12, after: 0.12 } : { baseline: 0.003, after: 0.14 },
    });
    return { ...base, fixture, script: fixScript(bug, clean, control.author.test), failure: { errorType: failure.errorType, message: failure.message } };
  }

  const telemetry = control.telemetry!;
  const fixture = fixtureFor({
    id: control.id,
    repo,
    initial: clean,
    deploy: { message: 'Update the README', changes: readme },
    failure: { message: telemetry.message, stack: telemetry.stack },
    timeline: NORMAL,
    errorsFrom: iso(NORMAL.deployedAt, 2),
    errorCount: 16,
    errorInterval: 60,
    monitorAt: iso(NORMAL.deployedAt, 4),
    errorRate: { baseline: 0.003, after: control.type === 'flaky_test' ? 0.03 : 0.1 },
  });
  const t = control.author.test;
  // An eager author proposes a change whatever the evidence says.
  const patchFile = control.author.patch ?? { path: repo.entry, content: `${clean[repo.entry]!}\n` };
  const script: SeedScript = {
    regressionTest: { path: t.path, source: t.source, expectedFailureMarkers: t.markers, expectedFailureDescription: t.description },
    patch: {
      rootCause: `${telemetry.errorType} in ${repo.service}.`,
      explanation: 'Retry the failing call.',
      files: [patchFile],
      risks: [],
      rollbackPlan: 'Revert the merge commit.',
      confidence: 0.6,
    },
  };
  return { ...base, fixture, script, failure: { errorType: telemetry.errorType, message: telemetry.message } };
}
