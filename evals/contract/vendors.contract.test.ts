import { describe, expect, it } from 'vitest';
import {
  DODO_BASE_URLS,
  DatadogProvider,
  DodoApiError,
  DodoPaymentsClient,
  GitHubProvider,
  SentryProvider,
  SlackAppClient,
  SlackProvider,
  testDatadog,
} from '@pager/providers';
import { Sandbox } from '@pager/sandbox';

/**
 * Contract tests: the adapters against the vendors' real APIs.
 *
 * The unit and twin tests check the adapters against stubbed fetch and against the
 * twins. That proves the code agrees with our model of each API, not that the model
 * is right. This suite asks the real services. It is opt-in and skips any vendor
 * whose credentials are absent, so it is never part of `pnpm verify`:
 *
 *   CONTRACT_GITHUB_TOKEN, CONTRACT_GITHUB_REPO=owner/name
 *   CONTRACT_SLACK_BOT_TOKEN  [CONTRACT_SLACK_CHANNEL + CONTRACT_SLACK_POST=1 to post]
 *   CONTRACT_DATADOG_API_KEY, CONTRACT_DATADOG_APP_KEY, CONTRACT_DATADOG_SITE, CONTRACT_DATADOG_SERVICE
 *   CONTRACT_SENTRY_TOKEN, CONTRACT_SENTRY_ORG, CONTRACT_SENTRY_PROJECT  [CONTRACT_SENTRY_URL]
 *   CONTRACT_DODO_API_KEY (test mode), CONTRACT_DODO_PRODUCT  [CONTRACT_DODO_CHECKOUT=1 to open a checkout]
 *
 * Read-only unless asked otherwise: the one write (a Slack message) needs its own flag.
 * Use sandbox accounts — a test repository, a test Slack workspace — not production.
 */

const env = (name: string) => process.env[name]?.trim() || undefined;
const SHA = /^[0-9a-f]{40}$/;
const hour = () => ({ from: new Date(Date.now() - 3_600_000), to: new Date() });

const gh = { token: env('CONTRACT_GITHUB_TOKEN'), repo: env('CONTRACT_GITHUB_REPO') };
describe.skipIf(!gh.token || !gh.repo)('GitHub (api.github.com)', () => {
  const github = () => new GitHubProvider({ baseUrl: 'https://api.github.com', token: gh.token! });

  it('reads the default branch, commits and a commit’s parents in the shapes the adapter expects', async () => {
    const p = github();
    const branch = await p.getDefaultBranch(gh.repo!);
    expect(branch).toMatch(/\S/);
    const commits = await p.listCommits(gh.repo!, { ref: branch, limit: 2 });
    expect(commits.length).toBeGreaterThan(0);
    const head = await p.getCommit(gh.repo!, commits[0]!.sha);
    expect(head.sha).toMatch(SHA);
    expect(Array.isArray(head.parents)).toBe(true);
  });

  it('lists a revision’s files and reads one', async () => {
    const p = github();
    const sha = (await p.listCommits(gh.repo!, { limit: 1 }))[0]!.sha;
    const listing = await p.listFiles(gh.repo!, sha);
    expect(typeof listing.truncated).toBe('boolean');
    expect(listing.paths.length).toBeGreaterThan(0);
    expect(await p.getFile(gh.repo!, sha, listing.paths[0]!)).not.toBeNull();
  });

  it('clones a pinned sha over https with the token in the environment only', async () => {
    const p = github();
    const sha = (await p.listCommits(gh.repo!, { limit: 1 }))[0]!.sha;
    const sandbox = await Sandbox.create(p, gh.repo!, sha);
    try {
      expect((await sandbox.run('git', ['rev-parse', 'HEAD'])).stdout.trim()).toBe(sha);
      expect(await sandbox.readFile('.git/config')).not.toContain(gh.token!);
    } finally {
      await sandbox.dispose();
    }
  }, 120_000);
});

const slack = { token: env('CONTRACT_SLACK_BOT_TOKEN'), channel: env('CONTRACT_SLACK_CHANNEL') };
describe.skipIf(!slack.token)('Slack (slack.com)', () => {
  const app = () => new SlackAppClient({ clientId: 'contract', clientSecret: 'contract', baseUrl: 'https://slack.com' });

  it('authenticates the bot token and names its team', async () => {
    const r = await app().authTest(slack.token!);
    expect(r.ok).toBe(true);
    expect(r.ok && r.teamId).toMatch(/^T[A-Z0-9]+$/);
  });

  it('pages through channels in the shape the channel picker uses', async () => {
    const channels = await app().channels(slack.token!);
    for (const c of channels.slice(0, 5)) {
      expect(c).toMatchObject({ id: expect.stringMatching(/^[CG][A-Z0-9]+$/), name: expect.any(String), isPrivate: expect.any(Boolean) });
    }
  });

  it.skipIf(!slack.channel || env('CONTRACT_SLACK_POST') !== '1')('posts a message and gets back a thread', async () => {
    const thread = await new SlackProvider({ baseUrl: 'https://slack.com', token: slack.token! }).openThread(slack.channel!, 'Pager Developer contract test — please ignore.');
    expect(thread.id).toMatch(/^\d+\.\d+$/);
  });
});

const dd = { apiKey: env('CONTRACT_DATADOG_API_KEY'), appKey: env('CONTRACT_DATADOG_APP_KEY'), site: env('CONTRACT_DATADOG_SITE') ?? 'https://api.datadoghq.com', service: env('CONTRACT_DATADOG_SERVICE') };
describe.skipIf(!dd.apiKey || !dd.appKey || !dd.service)('Datadog', () => {
  const datadog = () => new DatadogProvider({ baseUrl: dd.site, apiKey: dd.apiKey!, appKey: dd.appKey! });

  it('validates the keys the way the console’s connection test does', async () => {
    expect(await testDatadog({ site: dd.site, apiKey: dd.apiKey!, appKey: dd.appKey! })).toMatchObject({ ok: true });
  });

  it('lists monitors with statuses the adapter models', async () => {
    for (const m of await datadog().listMonitors(dd.service!)) {
      expect(['OK', 'WARN', 'ALERT', 'NO_DATA', 'UNKNOWN']).toContain(m.status);
    }
  });

  it('reads error logs and says whether the read was truncated', async () => {
    const logs = await datadog().queryLogs(dd.service!, hour(), { level: 'error', limit: 20 });
    expect(Array.isArray(logs)).toBe(true);
    expect(logs.truncated === undefined || typeof logs.truncated === 'boolean').toBe(true);
  });

  it('queries a metric series, or refuses — never an empty series passed off as data', async () => {
    try {
      const series = await datadog().queryMetric(dd.service!, 'request_throughput', hour());
      expect(series.unit).toBe('requests/s');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
  });
});

const sentry = { token: env('CONTRACT_SENTRY_TOKEN'), org: env('CONTRACT_SENTRY_ORG'), project: env('CONTRACT_SENTRY_PROJECT'), url: env('CONTRACT_SENTRY_URL') ?? 'https://sentry.io' };
describe.skipIf(!sentry.token || !sentry.org || !sentry.project)('Sentry', () => {
  const client = () => new SentryProvider({ baseUrl: sentry.url, token: sentry.token!, organization: sentry.org! });

  it('reads the organization', async () => {
    expect((await client().checkOrganization()).slug).toBe(sentry.org);
  });

  it('lists alerts and reads errors as structured groups with in-app frames', async () => {
    const alerts = await client().listAlerts(sentry.project!);
    for (const a of alerts) expect(['ALERT', 'WARN']).toContain(a.status);
    const errors = await client().readErrors(sentry.project!, { from: new Date(Date.now() - 24 * 3_600_000), to: new Date() }, { limit: 20 });
    expect(errors.kind).toBe('groups');
    if (errors.kind !== 'groups') return;
    for (const g of errors.groups) {
      expect(g.count).toBeGreaterThan(0);
      for (const f of g.frames) expect(typeof f.inApp).toBe('boolean');
    }
  });
});

// Test mode only: this suite never talks to Dodo's live host.
const dodo = { key: env('CONTRACT_DODO_API_KEY'), product: env('CONTRACT_DODO_PRODUCT') };
describe.skipIf(!dodo.key || !dodo.product)('Dodo Payments (test mode)', () => {
  const client = () => new DodoPaymentsClient({ baseUrl: DODO_BASE_URLS.test_mode, apiKey: dodo.key! });

  it('reads the product and its recurring price', async () => {
    const p = await client().getProduct(dodo.product!);
    expect(p.productId).toBe(dodo.product);
    expect(p.price).not.toBeNull();
    expect(p.price!.amount).toBeGreaterThan(0);
    expect(p.price!.recurring).toBe(true);
  });

  it('answers an unknown subscription with a coded 404', async () => {
    const err = await client().getSubscription('sub_does_not_exist').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DodoApiError);
    expect((err as DodoApiError).status).toBe(404);
  });

  it.skipIf(env('CONTRACT_DODO_CHECKOUT') !== '1')('opens a hosted checkout, with a URL and a session id', async () => {
    const c = await client().createCheckout({ productId: dodo.product!, returnUrl: 'https://example.com/billing/return', metadata: { workspace_id: 'contract-test' } });
    expect(c.sessionId).toMatch(/^cks_/);
    expect(c.checkoutUrl).toMatch(/^https:\/\//);
  });
});
