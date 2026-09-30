/**
 * The whole console, locally, against the twins: no GitHub, Slack or Dodo account.
 *
 *   pnpm --filter @pager/api dev:stack        # twins on :4200, the API on :4000
 *   # then, in another terminal, the console with the variables it prints:
 *   cd apps/web && set -a && . ../../.pager/console.env && set +a && npx next dev -p 4100
 *
 * The ports are overridable (STACK_WEB_PORT, STACK_API_PORT, STACK_TWIN_PORT).
 *
 * GitHub sign-in goes to the GitHub twin; Dodo's checkout and customer portal are
 * pages the Dodo twin hosts, whose buttons send the signed webhooks to this API. So
 * sign-up, onboarding and buying a plan can be clicked through end to end. Every
 * value here is a twin's test value. Nothing reads .env, so no real key is used.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { LocalKeyWrapper } from '@pager/core';
import { CredentialVault, createDatabase, migrate } from '@pager/db';
import { GitHubAppClient, PAGER_APP_MANIFEST, SlackAppClient, dodoFromEnv, registerViaManifest } from '@pager/providers';
import { INC_001, LocalTwinServer, TWIN_DODO, seedFromFixture } from '@pager/twin-local';
import { buildApp } from './app.ts';

// Overridable when these ports are taken: STACK_WEB_PORT, STACK_API_PORT, STACK_TWIN_PORT.
const WEB_PORT = Number(process.env.STACK_WEB_PORT ?? 4100);
const API_PORT = Number(process.env.STACK_API_PORT ?? 4000);
const TWIN_PORT = Number(process.env.STACK_TWIN_PORT ?? 4200);
const WEB = `http://127.0.0.1:${WEB_PORT}`;

async function main(): Promise<void> {
  const twin = new LocalTwinServer({ port: TWIN_PORT, now: () => Date.now() });
  twin.seed(seedFromFixture(INC_001));
  const e = await twin.start();
  twin.current.dodo.webhookUrl = `http://127.0.0.1:${API_PORT}/webhooks/dodo`;

  const creds = await registerViaManifest(e.github, { ...PAGER_APP_MANIFEST(e.github), setupUrl: `${WEB}/onboarding/github/setup` });
  const github = new GitHubAppClient({
    ...creds,
    slug: creds.slug!,
    clientId: creds.clientId!,
    clientSecret: creds.clientSecret!,
    webhookSecret: creds.webhookSecret!,
    apiBaseUrl: e.github,
    webBaseUrl: e.github,
  });
  const sessionSecret = randomBytes(24).toString('hex');
  const handle = await createDatabase('pglite://memory');
  await migrate(handle);
  const app = await buildApp({
    db: handle.db,
    sessionSecret,
    webOrigin: WEB,
    vault: new CredentialVault(handle.db, new LocalKeyWrapper(randomBytes(32).toString('base64'))),
    github,
    slack: { client: new SlackAppClient({ clientId: 'twin-slack-client', clientSecret: 'twin-slack-secret', baseUrl: e.slack }), redirectUri: `${WEB}/onboarding/slack/callback` },
    configPolicy: {
      allowDatadogUrl: (url) => url === e.datadog,
      allowSentryUrl: (url) => url === e.sentry,
      allowPrivateHealthUrl: true,
      notionBaseUrl: e.notion,
      resendBaseUrl: e.resend,
    },
    billing: dodoFromEnv({
      DODO_PAYMENTS_API_KEY: TWIN_DODO.apiKey,
      DODO_PAYMENTS_WEBHOOK_SECRET: TWIN_DODO.webhookSecret,
      DODO_PRODUCT_TEAM: TWIN_DODO.teamProduct,
      PAGER_DODO_URL: `http://127.0.0.1:${TWIN_PORT}/dodo`,
    }),
    logLevel: 'info',
  });
  await app.listen({ port: API_PORT, host: '127.0.0.1' });

  const console_ = {
    PAGER_API_URL: `http://127.0.0.1:${API_PORT}`,
    PAGER_SESSION_SECRET: sessionSecret,
    AUTH_SECRET: randomBytes(32).toString('base64'),
    AUTH_URL: WEB,
    AUTH_TRUST_HOST: 'true',
    AUTH_GITHUB_ID: creds.clientId!,
    AUTH_GITHUB_SECRET: creds.clientSecret!,
    PAGER_GITHUB_WEB_URL: e.github,
    PAGER_GITHUB_API_URL: e.github,
    PAGER_LEGAL_NAME: 'Local Twin Operator',
    PAGER_SUPPORT_EMAIL: 'support@example.com',
  };
  mkdirSync('../../.pager', { recursive: true });
  writeFileSync('../../.pager/console.env', Object.entries(console_).map(([k, v]) => `${k}='${v}'`).join('\n') + '\n');
  console.log(`twins    ${e.github.replace('/github', '')}\napi      http://127.0.0.1:${API_PORT}\nconsole  variables written to .pager/console.env; start it with next dev -p ${WEB_PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
