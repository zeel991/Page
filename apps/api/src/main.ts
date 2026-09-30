import { LocalKeyWrapper } from '@pager/core';
import { CredentialVault } from '@pager/db';
import { SlackAppClient, githubAppFromEnv, dodoFromEnv } from '@pager/providers';
import { buildApp } from './app.ts';
import { openDatabase } from './db.ts';

const PORT = Number(process.env.PAGER_API_PORT ?? process.env.PORT ?? 4000);
// Loopback by default; a hosted API sets PAGER_API_HOST=0.0.0.0.
const HOST = process.env.PAGER_API_HOST ?? '127.0.0.1';

async function main(): Promise<void> {
  const secret = process.env.PAGER_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('PAGER_SESSION_SECRET must be set (at least 32 characters), and shared with the console.');
  }
  const handle = await openDatabase();
  const app = await buildApp({
    db: handle.db,
    sessionSecret: secret,
    webOrigin: process.env.PAGER_WEB_ORIGIN ?? 'http://127.0.0.1:4100',
    vault: new CredentialVault(handle.db, new LocalKeyWrapper(process.env.PAGER_MASTER_KEY)),
    github: githubAppFromEnv(process.env),
    slack:
      process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET
        ? {
            client: new SlackAppClient({
              clientId: process.env.SLACK_CLIENT_ID,
              clientSecret: process.env.SLACK_CLIENT_SECRET,
              baseUrl: process.env.PAGER_SLACK_URL ?? 'https://slack.com',
            }),
            redirectUri: `${process.env.PAGER_WEB_ORIGIN ?? 'http://127.0.0.1:4100'}/onboarding/slack/callback`,
          }
        : null,
    ...(process.env.LOG_LEVEL ? { logLevel: process.env.LOG_LEVEL } : {}),
    // Render (and most hosts) terminate TLS in a proxy that sets X-Forwarded-For.
    trustProxy: process.env.PAGER_TRUST_PROXY === '1',
    billing: dodoFromEnv(process.env),
  });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await app.listen({ port: PORT, host: HOST });
  console.log(`Pager Developer API listening on http://${HOST}:${PORT}`);
  console.log(`  database ${process.env.DATABASE_URL ?? 'pglite://.pager/db'}`);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
