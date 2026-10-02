import { afterEach, describe, expect, it } from 'vitest';
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
} from '@pager/providers';
import type { DeploymentRecord } from '@pager/providers';
import { AgentTracer, InMemorySink } from '@pager/observability';
import { INC_001, INC_009, INC_011, LocalTwinServer, seedFromFixture } from '@pager/twin-local';
import {
  IncidentWorkflow,
  TELEMETRY_WINDOW_MINUTES,
  isTestFile,
  pullRequestTitle,
  telemetryWindowsFor,
} from '../src/workflow.js';
import { NoPatchGenerator, ScriptedPatchGenerator } from '../src/patch-generator.js';
import { SCRIPTS } from '../src/sample-scripts.js';

let server: LocalTwinServer;

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

async function build(fixture: Parameters<typeof seedFromFixture>[0], generator: 'scripted' | 'none' | 'bad-test') {
  server = new LocalTwinServer({ now: () => Date.parse('2026-09-13T14:45:00Z') });
  server.seed(seedFromFixture(fixture));
  const e = await server.start();
  const creds = await registerViaManifest(e.github, PAGER_APP_MANIFEST(e.github));
  const tokens = new GitHubAppTokenSource(e.github, creds);
  const sink = new InMemorySink();

  const patchGenerator =
    generator === 'none'
      ? new NoPatchGenerator()
      : new ScriptedPatchGenerator({
          regressionTest: {
            path: 'test/regression.test.ts',
            source:
              generator === 'bad-test'
                ? `import { it } from 'node:test';\nimport assert from 'node:assert/strict';\nit('trivial', () => assert.ok(true));\n`
                : REGRESSION_TEST,
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

  const workflow = new IncidentWorkflow({
    observability: new DatadogProvider({ baseUrl: e.datadog }),
    sourceControl: new GitHubProvider({ baseUrl: e.github, tokenProvider: () => tokens.token() }),
    messaging: new SlackProvider({ baseUrl: e.slack }),
    issueTracker: new JiraProvider({ baseUrl: e.jira, projectKey: 'INC' }),
    knowledge: new NotionProvider({ baseUrl: e.notion, token: 't', parentPageId: 'runbook-checkout' }),
    email: new ResendProvider({ baseUrl: e.resend, apiKey: 're_t', from: 'p@acme.dev' }),
    tracer: new AgentTracer({ sink, lemma: null }),
    // The evidence window ends at the present, so seeded telemetry needs a clock.
    now: () => new Date('2026-09-13T15:10:00Z'),
    patchGenerator,
  });

  // The revision production is running, resolved the way the workflow demands it:
  // from deployment evidence, not from the head of the branch. In this fixture the
  // deployed commit IS the current head, but the workflow is never told that — it is
  // handed the record and reads the sha off it.
  const sourceControl = new GitHubProvider({ baseUrl: e.github, tokenProvider: () => tokens.token() });
  const tip = await sourceControl.listCommits(fixture.repository, { limit: 1 });
  const head = await sourceControl.getCommit(fixture.repository, tip[0]!.sha);
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

  return { workflow, sink, endpoints: e, deployment };
}

const input = {
  service: 'checkout-api',
  repository: 'acme/checkout-api',
  slackChannel: '#incidents',
  incidentKey: 'INC-184',
  teamEmails: ['team@acme.dev'],
};

afterEach(async () => {
  await server?.stop();
});

describe('Sentry as the alert source', () => {
  it('is noticed through Sentry’s issues, reads its structured frames, and says Sentry in the pull request', async () => {
    const { deployment, endpoints } = await build(INC_001, 'scripted');
    const tokens = new GitHubAppTokenSource(endpoints.github, await registerViaManifest(endpoints.github, PAGER_APP_MANIFEST(endpoints.github)));
    const sink = new InMemorySink();
    const workflow = new IncidentWorkflow({
      observability: new DatadogProvider({ baseUrl: endpoints.datadog }),
      alerts: new SentryProvider({ baseUrl: endpoints.sentry, token: 'sntrys_test', organization: 'acme', now: () => new Date('2026-09-13T15:10:00Z') }),
      sourceControl: new GitHubProvider({ baseUrl: endpoints.github, tokenProvider: () => tokens.token() }),
      messaging: new SlackProvider({ baseUrl: endpoints.slack }),
      issueTracker: null,
      knowledge: null,
      email: null,
      tracer: new AgentTracer({ sink, lemma: null }),
      now: () => new Date('2026-09-13T15:10:00Z'),
      patchGenerator: new ScriptedPatchGenerator(SCRIPTS['INC-001']!),
    });
    const result = await workflow.run({ ...input, deployment });
    expect(result.haltReason).toBeNull();
    expect(result.alert).toMatchObject({ backend: 'sentry', alertNoun: 'Sentry issue' });
    expect(result.alert!.primary!.topApplicationFrame).toMatchObject({ file: 'src/checkout/service.ts', line: 20, functionName: 'CheckoutService.createOrder' });
    const tools = sink.toolCalls.map((c) => c.toolName);
    expect(tools).toEqual(expect.arrayContaining(['observability.listAlerts', 'observability.readErrors']));
    expect(tools.some((t) => t.startsWith('datadog.'))).toBe(false);
    const pr = server.current.repositories.get('acme/checkout-api')!.pullRequests.find((p) => p.number === result.pullRequest!.number)!;
    expect(pr.body).toMatch(/Sentry issue "CHECKOUT-API-1: TypeError/);
    expect(pr.body).not.toMatch(/Datadog monitor/);
  });
});

describe('failures the deployment did not cause', () => {
  it('hands over, without a pull request, a failure that was already happening before the deployment', async () => {
    // Found by the benchmark: with no model investigating, nothing noticed the same
    // error an hour before the deploy, and a "fix" for this deploy was opened.
    const logs = INC_001.logs!.map((l) => (l.level === 'error' ? { ...l, from: '2026-09-13T13:50:00Z', count: 40, intervalSeconds: 90 } : l));
    const { workflow, deployment } = await build({ ...INC_001, logs }, 'scripted');
    const result = await workflow.run({ ...input, deployment });
    expect(result.pullRequest).toBeNull();
    expect(result.haltReason).toMatch(/predates the deployment/);
    expect(server.current.repositories.get('acme/checkout-api')!.pullRequests.filter((p) => p.number > 377)).toEqual([]);
  });

  it('still repairs a failure that began after it', async () => {
    const { workflow, deployment } = await build(INC_001, 'scripted');
    expect((await workflow.run({ ...input, deployment })).pullRequest).not.toBeNull();
  });
});

describe('repositories that are not the demo', () => {
  it('does not let a test that was already failing block the incident, and says which it set aside', async () => {
    // The deployed revision ships a broken, unrelated test alongside the bug.
    const LEGACY = `import { it } from 'node:test';\nimport assert from 'node:assert/strict';\nit('legacy importer keeps totals', () => assert.equal(1, 2));\n`;
    const commits = INC_001.commits.map((c, i, all) =>
      i === all.length - 1 ? { ...c, changes: [...c.changes, { path: 'test/legacy.test.ts', content: LEGACY }] } : c,
    );
    const { workflow, deployment } = await build({ ...INC_001, commits }, 'scripted');
    const result = await workflow.run({ ...input, deployment });
    expect(result.haltReason).toBeNull();
    expect(result.suiteBaseline).toMatchObject({ passed: false, known: true, failing: ['legacy importer keeps totals'] });
    const repo = server.current.repositories.get('acme/checkout-api')!;
    const pr = repo.pullRequests.find((p) => p.number === result.pullRequest!.number)!;
    expect(pr.body).toMatch(/Excluded from the gate/);
    expect(pr.body).toContain('`legacy importer keeps totals`');
  });

  it('recognises test files by the runners’ conventions, not by a list of names', () => {
    for (const path of ['src/cart/pricing.test.ts', 'lib/api.spec.js', 'tests/test_orders.py', 'app/orders_test.py', '__tests__/cart.jsx', 'test/integration/checkout.mjs']) {
      expect(isTestFile(path), path).toBe(true);
    }
    for (const path of ['src/checkout/service.ts', 'test/fixtures/order.json', 'test/helpers/build.ts', 'src/testing.ts']) {
      expect(isTestFile(path), path).toBe(false);
    }
  });

  it('opens the pull request against the repository’s own default branch, not an assumed main', async () => {
    const trunk = (b: string | undefined) => (b === 'main' ? 'trunk' : b);
    const fixture = {
      ...INC_001,
      defaultBranch: 'trunk',
      commits: INC_001.commits.map((c) => ({ ...c, ...(c.branch ? { branch: trunk(c.branch)! } : {}) })),
      pullRequests: (INC_001.pullRequests ?? []).map((p) => ({ ...p, baseRef: trunk(p.baseRef)! })),
    };
    const { workflow, deployment } = await build(fixture, 'scripted');
    const result = await workflow.run({ ...input, deployment });
    expect(result.haltReason).toBeNull();
    const repo = server.current.repositories.get('acme/checkout-api')!;
    expect([...repo.branches.keys()]).not.toContain('main');
    expect(repo.pullRequests.find((p) => p.number === result.pullRequest!.number)!.baseRef).toBe('trunk');
  });
});

describe('IncidentWorkflow', () => {
  it('runs alert → ticket → slack → fix → PR', async () => {
    const { workflow, deployment } = await build(INC_001, 'scripted');
    const result = await workflow.run({ ...input, deployment });

    expect(result.haltReason).toBeNull();
    expect(result.stage).toBe('awaiting_merge');
    expect(result.alert!.escalate).toBe(true);
    expect(result.issue!.key).toBe('INC-1');
    expect(result.reproduction!.proven).toBe(true);
    expect(result.pullRequest!.number).toBe(378);

    // Every side effect is visible in the twin's own state.
    const state = server.current;
    expect(state.issues[0]!.status).toBe('In Progress');
    expect(state.messages).toHaveLength(2);
    expect(state.repositories.get('acme/checkout-api')!.branches.has('pager/inc-184')).toBe(true);
  });

  it('marks the patch as scripted, never as though a model reasoned to it', async () => {
    const { workflow, deployment } = await build(INC_001, 'scripted');
    const result = await workflow.run({ ...input, deployment });
    expect(result.patch!.kind).toBe('scripted');
  });

  it('stops with the failure located when no patch generator is configured', async () => {
    // The dangerous alternative is guessing a fix, so it does everything else and
    // hands over.
    const { workflow, deployment } = await build(INC_001, 'none');
    const result = await workflow.run({ ...input, deployment });

    expect(result.stage).toBe('halted');
    expect(result.haltReason).toMatch(/No regression test could be authored \(generator: none\)/);
    expect(result.haltReason).toMatch(/src\/checkout\/service\.ts:20/);
    // The team was still told and the ticket still filed.
    expect(result.issue).not.toBeNull();
    expect(server.current.messages).toHaveLength(1);
    // But no branch and no pull request.
    expect(result.pullRequest).toBeNull();
    expect(server.current.repositories.get('acme/checkout-api')!.pullRequests).toHaveLength(1);
  });

  it('refuses to open a PR when the regression test does not exercise the bug', async () => {
    const { workflow, deployment } = await build(INC_001, 'bad-test');
    const result = await workflow.run({ ...input, deployment });

    expect(result.stage).toBe('halted');
    expect(result.haltReason).toMatch(/passed against the unpatched code/);
    expect(result.pullRequest).toBeNull();
  });

  it('does not escalate a documented failure mode', async () => {
    const { workflow, deployment } = await build(INC_009, 'scripted');
    const result = await workflow.run({ ...input, deployment });

    expect(result.stage).toBe('not_escalated');
    expect(result.issue).toBeNull();
    expect(server.current.issues).toHaveLength(0);
    expect(server.current.messages).toHaveLength(0);
  });

  it('does not escalate an alerting monitor with healthy telemetry', async () => {
    const { workflow, deployment } = await build(INC_011, 'scripted');
    const result = await workflow.run({ ...input, deployment });

    expect(result.stage).toBe('not_escalated');
    expect(result.alert!.rationale).toMatch(/more likely a monitor problem/);
    expect(server.current.issues).toHaveLength(0);
  });

  it('will not verify recovery for a pull request that was never merged', async () => {
    const { workflow, deployment } = await build(INC_001, 'scripted');
    const first = await workflow.run({ ...input, deployment });

    const after = await workflow.completeAfterMerge({
      ...input,
      pullRequestNumber: first.pullRequest!.number,
      slackThread: { id: server.current.messages[0]!.ts, channel: '#incidents' },
      issueKey: first.issue!.key,
      alert: first.alert!,
      rootCause: first.patch!.rootCause,
      baselineWindow: { from: new Date('2026-09-13T14:00:00Z'), to: new Date('2026-09-13T14:30:59Z') },
      incidentWindow: { from: new Date('2026-09-13T14:31:00Z'), to: new Date('2026-09-13T14:50:00Z') },
      postRemediationWindow: { from: new Date('2026-09-13T14:50:00Z'), to: new Date('2026-09-13T15:00:00Z') },
    });

    expect(after.haltReason).toMatch(/is open, not merged/);
    expect(after.recovery).toBeNull();
    expect(server.current.emails).toHaveLength(0);
  });

  it('keeps the incident open and sends nothing when signals have not recovered', async () => {
    const { workflow, deployment } = await build(INC_001, 'scripted');
    const first = await workflow.run({ ...input, deployment });

    const repo = server.current.repositories.get('acme/checkout-api')!;
    const pr = repo.pullRequests.find((p) => p.number === first.pullRequest!.number)!;
    pr.merged = true;
    pr.state = 'closed';
    pr.mergedAt = '2026-09-13T14:50:00Z';

    // Telemetry is left as-is: still broken.
    const after = await workflow.completeAfterMerge({
      ...input,
      pullRequestNumber: pr.number,
      slackThread: { id: server.current.messages[0]!.ts, channel: '#incidents' },
      issueKey: first.issue!.key,
      alert: first.alert!,
      rootCause: first.patch!.rootCause,
      baselineWindow: { from: new Date('2026-09-13T14:00:00Z'), to: new Date('2026-09-13T14:30:59Z') },
      incidentWindow: { from: new Date('2026-09-13T14:31:00Z'), to: new Date('2026-09-13T14:50:00Z') },
      postRemediationWindow: { from: new Date('2026-09-13T14:50:00Z'), to: new Date('2026-09-13T15:00:00Z') },
    });

    expect(after.recovery!.recovered).toBe(false);
    expect(after.haltReason).toMatch(/remains open/);
    expect(after.recoveryVerdict).toBe('NOT_RECOVERED');
    // No write-up and no email: there is nothing settled to report.
    expect(after.writeUpUrl).toBeNull();
    expect(server.current.emails).toHaveLength(0);
  });

  it('leaves the ticket open, and says why, when recovery could not be measured', async () => {
    // The README promises the incident stays open on UNVERIFIABLE. The ticket used
    // to be commented "recovery verified" and resolved regardless of the verdict.
    const { workflow, deployment } = await build(INC_001, 'scripted');
    const first = await workflow.run({ ...input, deployment });

    const repo = server.current.repositories.get('acme/checkout-api')!;
    const pr = repo.pullRequests.find((p) => p.number === first.pullRequest!.number)!;
    pr.merged = true;
    pr.state = 'closed';
    pr.mergedAt = '2026-09-13T14:50:00Z';

    const after = await workflow.completeAfterMerge({
      ...input,
      pullRequestNumber: pr.number,
      slackThread: { id: server.current.messages[0]!.ts, channel: '#incidents' },
      issueKey: first.issue!.key,
      alert: first.alert!,
      rootCause: first.patch!.rootCause,
      baselineWindow: { from: new Date('2026-09-13T14:00:00Z'), to: new Date('2026-09-13T14:30:59Z') },
      incidentWindow: { from: new Date('2026-09-13T14:31:00Z'), to: new Date('2026-09-13T14:50:00Z') },
      // A window with no telemetry at all: nothing can be compared.
      postRemediationWindow: { from: new Date('2026-09-20T00:00:00Z'), to: new Date('2026-09-20T00:15:00Z') },
    });

    expect(after.recoveryVerdict).toBe('UNVERIFIABLE');
    const issue = server.current.issues.find((i) => i.key === first.issue!.key)!;
    expect(issue.status).not.toBe('Resolved');
    const last = issue.comments.at(-1)!.body;
    expect(last).not.toMatch(/recovery verified/i);
    expect(last).toMatch(/could not be (measured|verified)/i);
    expect(last).toMatch(/open/i);
  });
});

describe('post-fix window', () => {
  it('refuses to measure recovery over traffic from before the merge', async () => {
    // The window used to be fixed at PR-open time, so a merge noticed later was
    // "verified" over the incident's own traffic.
    const { workflow, deployment } = await build(INC_001, 'scripted');
    const first = await workflow.run({ ...input, deployment });
    const repo = server.current.repositories.get('acme/checkout-api')!;
    const pr = repo.pullRequests.find((p) => p.number === first.pullRequest!.number)!;
    pr.merged = true;
    pr.state = 'closed';
    pr.mergedAt = '2026-09-13T15:30:00Z';

    const after = await workflow.completeAfterMerge({
      ...input,
      pullRequestNumber: pr.number,
      slackThread: { id: server.current.messages[0]!.ts, channel: '#incidents' },
      issueKey: first.issue!.key,
      alert: first.alert!,
      rootCause: first.patch!.rootCause,
      baselineWindow: { from: new Date('2026-09-13T14:00:00Z'), to: new Date('2026-09-13T14:30:59Z') },
      incidentWindow: { from: new Date('2026-09-13T14:31:00Z'), to: new Date('2026-09-13T14:50:00Z') },
      postRemediationWindow: { from: new Date('2026-09-13T14:50:00Z'), to: new Date('2026-09-13T15:05:00Z') },
    });

    expect(after.recoveryVerdict).toBe('UNVERIFIABLE');
    expect(after.recovery!.summary).toMatch(/before #\d+ merged at 2026-09-13T15:30:00.000Z/);
    // Nothing was queried for a window that cannot evidence anything.
    expect(after.recovery!.comparisons).toHaveLength(0);
  });

  it('reports why when the fix was never observed deployed', async () => {
    const { workflow, deployment } = await build(INC_001, 'scripted');
    const first = await workflow.run({ ...input, deployment });
    const repo = server.current.repositories.get('acme/checkout-api')!;
    const pr = repo.pullRequests.find((p) => p.number === first.pullRequest!.number)!;
    pr.merged = true;
    pr.state = 'closed';
    pr.mergedAt = '2026-09-13T14:50:00Z';

    const after = await workflow.completeAfterMerge({
      ...input,
      pullRequestNumber: pr.number,
      slackThread: { id: server.current.messages[0]!.ts, channel: '#incidents' },
      issueKey: first.issue!.key,
      alert: first.alert!,
      rootCause: first.patch!.rootCause,
      baselineWindow: { from: new Date('2026-09-13T14:00:00Z'), to: new Date('2026-09-13T14:30:59Z') },
      incidentWindow: { from: new Date('2026-09-13T14:31:00Z'), to: new Date('2026-09-13T14:50:00Z') },
      postRemediationWindow: { unavailable: 'the merge commit was never observed in the deployed revision' },
    });

    expect(after.recoveryVerdict).toBe('UNVERIFIABLE');
    expect(after.recovery!.summary).toMatch(/never observed in the deployed revision/);
  });
});

describe('telemetry windows', () => {
  const onset = new Date('2026-09-13T14:32:00Z');

  it('stops the baseline a guard band before the observed onset', () => {
    // A monitor lags its onset, and logs are sampled while metrics are continuous,
    // so the first observed error is only an upper bound on when things broke.
    const [baseline, observation] = telemetryWindowsFor(onset);
    expect(baseline.to.toISOString()).toBe('2026-09-13T14:28:59.999Z');
    expect(observation.from.toISOString()).toBe('2026-09-13T14:32:00.000Z');
  });

  it('never lets the windows overlap', () => {
    const [baseline, observation] = telemetryWindowsFor(onset);
    expect(baseline.to.getTime()).toBeLessThan(observation.from.getTime());
  });

  it('keeps a full-length baseline despite the guard band', () => {
    const [baseline] = telemetryWindowsFor(onset);
    const minutes = (baseline.to.getTime() - baseline.from.getTime()) / 60_000;
    expect(Math.round(minutes)).toBe(TELEMETRY_WINDOW_MINUTES);
  });
});

describe('pull request title', () => {
  it('keeps a short root cause whole', () => {
    expect(pullRequestTitle('INC-1', 'Guard the optional discount code.')).toBe(
      'INC-1: Guard the optional discount code',
    );
  });

  it('truncates a long one at a word boundary and marks it', () => {
    // Real titles were hundreds of characters — unreadable in any PR list.
    const long =
      'CheckoutService.createOrder dereferenced an optional request.destination and the ' +
      'result of rateFor(), whose declared return type falsely excluded undefined, so ' +
      'requests with no destination threw raw TypeErrors';
    const title = pullRequestTitle('INC-BE5404871B81', long);
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title.endsWith('…')).toBe(true);
    expect(title).toMatch(/^INC-BE5404871B81: /);
    // The real property: the kept text is a whole-word prefix of the original,
    // so no word is cut in half.
    const kept = title.replace(/^INC-BE5404871B81: /, '').replace('…', '');
    expect(long.startsWith(kept)).toBe(true);
    expect(long[kept.length]).toBe(' ');
  });

  it('collapses the newlines model prose arrives with', () => {
    expect(pullRequestTitle('INC-2', 'Guard  the\n\n  code.')).toBe('INC-2: Guard the code');
  });
});

describe('forward-only advance', () => {
  it('walks intermediate states, skips states already passed, and goes direct off the path', async () => {
    const { forwardSteps } = await import('../src/workflow.js');
    expect(forwardSteps('INCIDENT_OPEN', 'INVESTIGATING')).toEqual(['INVESTIGATING']);
    // A resumed run that finds the incident at VALIDATING and is asked for AWAITING_APPROVAL.
    expect(forwardSteps('VALIDATING', 'AWAITING_APPROVAL')).toEqual(['FIX_READY', 'AWAITING_APPROVAL']);
    // A second repair pass asking for FIXING again is a no-op, not an illegal transition.
    expect(forwardSteps('VALIDATING', 'FIXING')).toEqual([]);
    expect(forwardSteps('FIXING', 'FIXING')).toEqual([]);
    expect(forwardSteps('REPRODUCING', 'UNRESOLVED')).toEqual(['UNRESOLVED']);
  });
});
