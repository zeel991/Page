import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { LocalKeyWrapper, signToken } from '@pager/core';
import { CredentialVault, IdentityRepository, createDatabase, migrate, type DatabaseHandle } from '@pager/db';
import { GitHubAppClient, PAGER_APP_MANIFEST, SlackAppClient, registerViaManifest } from '@pager/providers';
import { INC_001, LocalTwinServer, seedFromFixture } from '@pager/twin-local';
import { buildApp, type AppDeps } from '../src/app.ts';

/**
 * An API wired to the local twins, as a fresh deployment would be: a GitHub App
 * registered through the manifest flow, and nothing else configured.
 */

export const SECRET = 'test-session-secret-0123456789abcdef';

export interface Harness {
  app: FastifyInstance;
  handle: DatabaseHandle;
  twin: LocalTwinServer;
  endpoints: Awaited<ReturnType<LocalTwinServer['start']>>;
  github: GitHubAppClient;
  slack: SlackAppClient;
  vault: CredentialVault;
  close(): Promise<void>;
  /** Sign in as a GitHub user and return a session for their first workspace. */
  signIn(login: string, subject: string, email?: string | null): Promise<{ userId: string; org: string; token: string }>;
  call(method: string, url: string, token: string, payload?: unknown): ReturnType<FastifyInstance['inject']>;
}

export async function harness(extra: Partial<AppDeps> = {}): Promise<Harness> {
  const twin = new LocalTwinServer({ now: () => Date.now() });
  twin.seed(seedFromFixture(INC_001));
  const endpoints = await twin.start();
  const creds = await registerViaManifest(endpoints.github, {
    ...PAGER_APP_MANIFEST(endpoints.github),
    setupUrl: 'http://console.test/onboarding/github/setup',
  });
  const github = new GitHubAppClient({
    ...creds,
    slug: creds.slug!,
    clientId: creds.clientId!,
    clientSecret: creds.clientSecret!,
    webhookSecret: creds.webhookSecret!,
    apiBaseUrl: endpoints.github,
    webBaseUrl: endpoints.github,
  });

  const handle = await createDatabase('pglite://memory');
  await migrate(handle);
  const vault = new CredentialVault(handle.db, new LocalKeyWrapper(randomBytes(32).toString('base64')));
  const slack = new SlackAppClient({ clientId: 'twin-slack-client', clientSecret: 'twin-slack-secret', baseUrl: endpoints.slack });
  const app = await buildApp({
    db: handle.db, sessionSecret: SECRET, webOrigin: 'http://console.test', vault, github,
    slack: { client: slack, redirectUri: 'http://console.test/onboarding/slack/callback' },
    // The twins are local http servers; production accepts only Datadog's own hosts
    // and public https health URLs.
    configPolicy: {
      allowDatadogUrl: (url) => url === endpoints.datadog,
      allowPrivateHealthUrl: true,
      notionBaseUrl: endpoints.notion,
      resendBaseUrl: endpoints.resend,
    },
    ...extra,
  });
  const identity = new IdentityRepository(handle.db);

  return {
    app, handle, twin, endpoints, github, slack, vault,
    async close() {
      await app.close();
      await handle.close();
      await twin.stop();
    },
    async signIn(login, subject, email = null) {
      const { user, workspaces } = await identity.signIn({ provider: 'github', subject, login, email, name: login, avatarUrl: null });
      const org = workspaces[0]!.id;
      return { userId: user.id, org, token: signToken(SECRET, 'api-session', { sub: user.id, org }, 600) };
    },
    call(method, url, token, payload) {
      return app.inject({
        method: method as 'GET',
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      });
    },
  };
}

/**
 * What a browser does between "Install" and landing back on the console: follow the
 * install URL to GitHub (the twin), which installs the app and redirects to the setup
 * URL with the installation id, the state, and an OAuth code.
 */
export async function installThroughGitHub(installUrl: string, opts: { login?: string; repositories?: string[] } = {}) {
  const url = new URL(installUrl);
  if (opts.login) url.searchParams.set('login', opts.login);
  if (opts.repositories) url.searchParams.set('repositories', opts.repositories.join(','));
  const res = await fetch(url, { redirect: 'manual' });
  const location = new URL(res.headers.get('location')!);
  return {
    installationId: Number(location.searchParams.get('installation_id')),
    state: location.searchParams.get('state')!,
    code: location.searchParams.get('code')!,
  };
}

/** Follow Slack's consent redirect back to the console, as a browser would. */
export async function installThroughSlack(installUrl: string) {
  const res = await fetch(installUrl, { redirect: 'manual' });
  const location = new URL(res.headers.get('location')!);
  return { code: location.searchParams.get('code')!, state: location.searchParams.get('state')! };
}

/** A health endpoint reporting a revision, as a deployed service would. */
export async function healthServer(commit: () => string | null) {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ...(commit() ? { commit: commit() } : {}) }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/health`;
  return { url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/**
 * Everything a new workspace does, through the API alone: sign in, install the
 * GitHub App and pick the repository, connect Datadog and Slack, add the service.
 */
export async function onboard(h: Harness, opts: { login?: string; subject?: string; healthUrl: string }) {
  const session = await h.signIn(opts.login ?? 'octo', opts.subject ?? '1001', 'octo@acme.dev');
  const { url: gh } = (await h.call('GET', '/api/github/install-url', session.token)).json() as { url: string };
  await h.call('POST', '/api/github/setup', session.token, await installThroughGitHub(gh, { repositories: ['acme/checkout-api'] }));
  const repo = (await h.call('POST', '/api/repositories', session.token, { fullName: 'acme/checkout-api' })).json() as { repository: { id: string } };
  await h.call('PUT', '/api/integrations/datadog', session.token, { site: h.endpoints.datadog, apiKey: 'dd-api-key-0123456789', appKey: 'dd-app-key-0123456789' });
  const { url: sl } = (await h.call('GET', '/api/slack/install-url', session.token)).json() as { url: string };
  await h.call('POST', '/api/slack/oauth', session.token, await installThroughSlack(sl));
  const created = await h.call('POST', '/api/services', session.token, {
    name: 'checkout-api',
    repositoryId: repo.repository.id,
    healthUrl: opts.healthUrl,
    slackChannelId: '#incidents',
  });
  if (created.statusCode !== 200) throw new Error(`service not created: ${created.body}`);
  return { session, repositoryId: repo.repository.id, service: (created.json() as { service: { id: string } }).service };
}
