import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GitHubAppTokenSource,
  GitHubProvider,
  DatadogProvider,
  SlackProvider,
  PAGER_APP_MANIFEST,
  registerViaManifest,
} from '@pager/providers';
import { LocalTwinServer } from '../src/server.js';
import { seedFromFixture } from '../src/seed.js';
import { INC_001 } from '../src/fixtures/index.js';

/**
 * These exercise the local twin through the real provider adapters — the same code
 * that talks to Arga and to the real vendors. A twin tested through a bespoke client
 * would prove nothing about the code that actually ships.
 */

let server: LocalTwinServer;
let endpoints: { github: string; datadog: string; slack: string };

beforeEach(async () => {
  server = new LocalTwinServer({ now: () => Date.parse('2026-09-13T14:45:00Z') });
  server.seed(seedFromFixture(INC_001));
  endpoints = await server.start();
});

afterEach(async () => {
  await server.stop();
});

async function github(): Promise<GitHubProvider> {
  const creds = await registerViaManifest(endpoints.github, PAGER_APP_MANIFEST(endpoints.github));
  const tokens = new GitHubAppTokenSource(endpoints.github, creds);
  return new GitHubProvider({ baseUrl: endpoints.github, tokenProvider: () => tokens.token() });
}

describe('local GitHub twin', () => {
  it('completes the GitHub App manifest and installation token flow', async () => {
    const creds = await registerViaManifest(endpoints.github, PAGER_APP_MANIFEST(endpoints.github));
    expect(creds.privateKeyPem).toContain('PRIVATE KEY');

    const tokens = new GitHubAppTokenSource(endpoints.github, creds);
    const token = await tokens.token();
    expect(token).toMatch(/^ghs_/);
    expect(tokens.grantedPermissions).toMatchObject({ contents: 'write', pull_requests: 'write' });
  });

  it('rejects unauthenticated reads of commits', async () => {
    const anon = new GitHubProvider({ baseUrl: endpoints.github });
    await expect(anon.listCommits('acme/checkout-api')).rejects.toThrow(/401/);
  });

  it('produces a real file-level diff, which the hosted twin cannot', async () => {
    const gh = await github();
    const history = await gh.listCommits('acme/checkout-api', { limit: 10 });
    const head = await gh.getCommit('acme/checkout-api', history[0]!.sha);
    const diff = await gh.getDiff('acme/checkout-api', head.parents[0]!, head.sha);

    expect(diff.files.map((f) => f.path)).toEqual(['src/checkout/types.ts']);
    const changed = diff.files[0]!;
    expect(changed.status).toBe('modified');
    // Line counts are derived from the content, not declared by the fixture.
    expect(changed.additions).toBeGreaterThan(0);
    expect(diff.patch).toContain('discountCode?: DiscountCode | null');
  });

  it('associates the deployment commit with its pull request', async () => {
    const gh = await github();
    const history = await gh.listCommits('acme/checkout-api', { limit: 10 });
    const prs = await gh.listPullRequestsForCommit('acme/checkout-api', history[0]!.sha);

    expect(prs).toHaveLength(1);
    expect(prs[0]!.number).toBe(377);
    expect(prs[0]!.state).toBe('merged');
  });

  it('serves file contents at a given revision', async () => {
    const gh = await github();
    const history = await gh.listCommits('acme/checkout-api', { limit: 10 });
    const head = history[0]!.sha;

    const after = await gh.getFile('acme/checkout-api', head, 'src/checkout/types.ts');
    expect(after).toContain('discountCode?: DiscountCode | null');

    const parent = (await gh.getCommit('acme/checkout-api', head)).parents[0]!;
    const before = await gh.getFile('acme/checkout-api', parent, 'src/checkout/types.ts');
    expect(before).toContain('discountCode: DiscountCode;');
    expect(before).not.toContain('?:');
  });

  it('creates a fix branch and opens a pull request', async () => {
    const gh = await github();
    const history = await gh.listCommits('acme/checkout-api', { limit: 10 });
    const branch = await gh.createBranch('acme/checkout-api', history[0]!.sha, 'pager/incident-184');
    expect(branch.name).toBe('pager/incident-184');

    const pr = await gh.createPullRequest('acme/checkout-api', {
      title: 'Fix null discount code in createOrder',
      body: 'Incident INC-184',
      headRef: 'pager/incident-184',
      baseRef: 'main',
    });
    expect(pr.number).toBe(378);
    expect(pr.state).toBe('open');
  });

  it('refuses, with 409, a merge pinned to a head that has since moved', async () => {
    // Real GitHub answers 409 when the sha in a merge request is not the head.
    const { PullRequestChangedError } = await import('@pager/providers');
    const gh = await github();
    const history = await gh.listCommits('acme/checkout-api', { limit: 10 });
    await gh.createBranch('acme/checkout-api', history[0]!.sha, 'pager/pinned');
    const pr = await gh.createPullRequest('acme/checkout-api', {
      title: 't', body: 'b', headRef: 'pager/pinned', baseRef: 'main',
    });
    const reviewed = pr.headSha;
    // A commit lands on the branch after review.
    await gh.commitFiles('acme/checkout-api', {
      branch: 'pager/pinned', message: 'unreviewed', changes: [{ path: 'NOTES.md', content: 'x' }],
    });

    await expect(gh.mergePullRequest('acme/checkout-api', pr.number, { sha: reviewed })).rejects.toBeInstanceOf(
      PullRequestChangedError,
    );
    expect((await gh.getPullRequest('acme/checkout-api', pr.number)).state).toBe('open');

    const head = (await gh.getPullRequest('acme/checkout-api', pr.number)).headSha;
    const merged = await gh.mergePullRequest('acme/checkout-api', pr.number, { sha: head });
    expect(merged.state).toBe('merged');
    expect(merged.mergedAt).toEqual(new Date('2026-09-13T14:45:00Z'));
  });

  describe('pagination and truncation', () => {
    const repoState = () => server.current.repositories.get('acme/checkout-api')!;
    /** Extend history with commits built directly in the twin's state. */
    function extend(count: number, change: (i: number, files: Map<string, string>) => void) {
      const repo = repoState();
      let parent = repo.commits[0]!;
      for (let i = 0; i < count; i++) {
        const files = new Map(parent.files);
        change(i, files);
        const commit = { ...parent, sha: `${String(i).padStart(4, '0')}${'f'.repeat(36)}`, message: `c${i}`, parents: [parent.sha], files };
        repo.commits.unshift(commit);
        parent = commit;
      }
      repo.branches.set('main', parent.sha);
      return parent.sha;
    }

    it('pages through every commit in a large deployment', async () => {
      const gh = await github();
      const base = repoState().commits[0]!.sha;
      const head = extend(260, (i, f) => f.set('CHANGELOG.md', `v${i}`));
      // Unpaged, compare returns 250: the oldest ten would be silently missing.
      const commits = await gh.listCommitsBetween('acme/checkout-api', base, head);
      expect(commits).toHaveLength(260);
    });

    it('marks a diff at GitHub’s 300-file cap as truncated', async () => {
      const gh = await github();
      const base = repoState().commits[0]!.sha;
      const head = extend(1, (_i, f) => {
        for (let n = 0; n < 305; n++) f.set(`gen/file-${n}.ts`, `export const n = ${n};`);
      });
      const diff = await gh.getDiff('acme/checkout-api', base, head);
      expect(diff.files).toHaveLength(300);
      expect(diff.truncated).toBe(true);
      const small = await gh.getDiff('acme/checkout-api', repoState().commits[1]!.sha, repoState().commits[1]!.sha);
      expect(small.truncated).toBe(false);
    });

    it('reports a truncated tree listing as truncated', async () => {
      const gh = await github();
      server.current.limits = { treeEntries: 2 };
      const head = repoState().commits[0]!.sha;
      const listing = await gh.listFiles('acme/checkout-api', head);
      expect(listing).toMatchObject({ truncated: true });
      expect(listing.paths).toHaveLength(2);
    });

    // Files over 1 MB came back as null — the same answer as "no such file".
    it('reads a file too large to inline through the blob API', async () => {
      const gh = await github();
      server.current.limits = { inlineFileBytes: 10 };
      const head = extend(1, (_i, f) => {
        f.set('data/big.json', JSON.stringify({ rows: 'x'.repeat(50) }));
        f.set('data/empty.txt', '');
      });
      expect(await gh.getFile('acme/checkout-api', head, 'data/big.json')).toBe(JSON.stringify({ rows: 'x'.repeat(50) }));
      // An empty file is empty, not missing.
      expect(await gh.getFile('acme/checkout-api', head, 'data/empty.txt')).toBe('');
      expect(await gh.getFile('acme/checkout-api', head, 'data/absent.txt')).toBeNull();
    });
  });

  it('refuses a branch that already exists', async () => {
    const gh = await github();
    const history = await gh.listCommits('acme/checkout-api', { limit: 10 });
    await gh.createBranch('acme/checkout-api', history[0]!.sha, 'pager/dup');
    await expect(gh.createBranch('acme/checkout-api', history[0]!.sha, 'pager/dup')).rejects.toThrow(/422/);
  });

  it('restores seeded state on reset, discarding agent side effects', async () => {
    const gh = await github();
    const history = await gh.listCommits('acme/checkout-api', { limit: 10 });
    await gh.createBranch('acme/checkout-api', history[0]!.sha, 'pager/incident-1');
    await gh.createPullRequest('acme/checkout-api', {
      title: 't', body: 'b', headRef: 'pager/incident-1', baseRef: 'main',
    });
    expect(server.current.repositories.get('acme/checkout-api')!.pullRequests).toHaveLength(2);

    server.reset();
    expect(server.current.repositories.get('acme/checkout-api')!.pullRequests).toHaveLength(1);
    expect(server.current.repositories.get('acme/checkout-api')!.branches.has('pager/incident-1')).toBe(false);
  });
});

describe('local Datadog twin', () => {
  const range = { from: new Date('2026-09-13T14:00:00Z'), to: new Date('2026-09-13T15:00:00Z') };
  const datadog = () => new DatadogProvider({ baseUrl: endpoints.datadog });

  it('serves a metric series that rises after the deployment', async () => {
    const series = await datadog().queryMetric('checkout-api', 'error_rate', range);
    const deployedAt = Date.parse('2026-09-13T14:31:00Z');
    const before = series.points.filter((p) => p.at.getTime() < deployedAt);
    const after = series.points.filter((p) => p.at.getTime() >= deployedAt);

    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(before.map((p) => p.value))).toBeLessThan(0.01);
    expect(mean(after.map((p) => p.value))).toBeGreaterThan(0.15);
  });

  it('keeps latency flat, so a correctness failure is not read as saturation', async () => {
    const series = await datadog().queryMetric('checkout-api', 'latency_p95', range);
    const values = series.points.map((p) => p.value);
    expect(Math.max(...values)).toBeLessThan(220);
  });

  it('serves error logs carrying the stack trace', async () => {
    const logs = await datadog().queryLogs('checkout-api', range, { level: 'error' });
    expect(logs.length).toBeGreaterThan(10);
    expect(logs[0]!.stackTrace).toContain('src/checkout/service.ts:20');
    expect(logs[0]!.message).toContain("Cannot read properties of null");
  });

  it('reports the alerting monitor and the healthy one distinctly', async () => {
    const monitors = await datadog().listMonitors('checkout-api');
    expect(monitors.find((m) => m.name.includes('error rate'))!.status).toBe('ALERT');
    expect(monitors.find((m) => m.name.includes('latency'))!.status).toBe('OK');
  });

  // One request of `limit` entries, with no cursor, dropped everything past the
  // first page without saying so.
  it('pages logs by cursor and says when more matched than were read', async () => {
    const dd = datadog();
    const base = Date.parse('2026-09-13T14:40:00Z');
    server.current.logs = Array.from({ length: 250 }, (_, i) => ({
      at: base + i * 1000, service: 'checkout-api', level: 'error', message: `e${i}`, stack: null, attributes: {},
    }));
    const window = { from: new Date(base - 1), to: new Date(base + 300_000) };

    const some = await dd.queryLogs('checkout-api', window, { level: 'error', limit: 200 });
    expect(some).toHaveLength(200);
    expect(some.truncated).toBe(true);
    // The budget went on the newest entries, returned oldest-first.
    expect(some[0]!.message).toBe('e50');
    expect(some.at(-1)!.message).toBe('e249');

    const all = await dd.queryLogs('checkout-api', window, { level: 'error', limit: 500 });
    expect(all).toHaveLength(250);
    expect(all.truncated).toBe(false);
  });

  it('answers a malformed query with an error rather than an empty series', async () => {
    const dd = datadog();
    // No service tag: the adapter must not read this as "no data, all healthy".
    // It now refuses before sending; the twin's 200-with-error answer to a query
    // it cannot parse is covered in the adapter tests.
    await expect(
      dd.queryMetric('', 'error_rate', range),
    ).rejects.toThrow(/unsafe service/);
  });
});

describe('local Slack twin', () => {
  const slack = () => new SlackProvider({ baseUrl: endpoints.slack });

  it('opens a thread and reads it back', async () => {
    const s = slack();
    const thread = await s.openThread('#incidents', 'Production regression detected');
    await s.replyInThread(thread, 'Investigation update');

    const messages = await s.readThread(thread);
    expect(messages.map((m) => m.text)).toEqual([
      'Production regression detected',
      'Investigation update',
    ]);
  });

  it('reads a whole thread, following the replies cursor', async () => {
    const slack = new SlackProvider({ baseUrl: endpoints.slack });
    const thread = await slack.openThread('#incidents', 'opening');
    for (let i = 0; i < 4; i++) await slack.replyInThread(thread, `reply ${i}`);
    const read = await slack.readThread(thread);
    expect(read.map((m) => m.text)).toEqual(['opening', 'reply 0', 'reply 1', 'reply 2', 'reply 3']);
  });

  it('rejects an unknown channel the way Slack does, with ok:false', async () => {
    await expect(slack().openThread('#does-not-exist', 'hi')).rejects.toThrow(/channel_not_found/);
  });
});
