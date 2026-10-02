import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { CredentialVault, Database } from '@pager/db';
import type { DodoBillingConfig, GitHubAppClient, SlackAppClient } from '@pager/providers';
import { registerSlackRoutes } from './slack-routes.ts';
import { registerConfigRoutes, type ConfigPolicy } from './config-routes.ts';
import { registerCredentialRoutes } from './credential-routes.ts';
import { registerGitHubRoutes, registerGitHubWebhook } from './github-routes.ts';
import { registerSentryWebhook } from './sentry-webhook.ts';
import { internalGuard, sessionGuard } from './auth.ts';
import { registerInternalRoutes } from './internal-routes.ts';
import { registerConsoleRoutes } from './routes.ts';
import { RateLimiter, rateLimitHook, type RateLimitOptions } from './rate-limit.ts';
import { BillingService, registerBillingRoutes, registerDodoWebhook, registerPublicBillingRoutes } from './billing-routes.ts';

export interface AppDeps {
  db: Database;
  /** Shared with the console, which signs session and internal tokens with it. */
  sessionSecret: string;
  /** The console's origin. The only origin a browser may call from. */
  webOrigin: string;
  /** Tenant secrets, envelope-encrypted under PAGER_MASTER_KEY. */
  vault: CredentialVault;
  /** The operator's GitHub App. Null disables installing and repository picking. */
  github?: GitHubAppClient | null;
  /** The operator's Slack app, and the console page Slack returns to after install. */
  slack?: { client: SlackAppClient; redirectUri: string } | null;
  /** Relaxations for tests against local twins. Production leaves this unset. */
  configPolicy?: ConfigPolicy;
  logLevel?: string;
  /**
   * Requests per minute: per signed-in person on console routes, per sender address
   * on webhooks. Defaults 600 and 600.
   */
  rateLimits?: { console?: RateLimitOptions; webhooks?: RateLimitOptions };
  /**
   * Behind a load balancer (Render), the sender's address is in X-Forwarded-For.
   * Only set it when a proxy is in front: otherwise a caller could claim any address.
   */
  trustProxy?: boolean;
  /** The clock the console's month-to-date figures use. Tests set it; production leaves it. */
  now?: () => Date;
  /** Dodo Payments, for paid plans. Null: only the free plan, and the console says so. */
  billing?: DodoBillingConfig | null;
}

/**
 * The API, assembled. Separate from `main.ts` so tests can drive it with `inject`.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: deps.logLevel ?? 'warn' }, trustProxy: deps.trustProxy ?? false });
  const consoleLimiter = new RateLimiter(deps.rateLimits?.console ?? { limit: 600, windowMs: 60_000 });
  const webhookLimiter = new RateLimiter(deps.rateLimits?.webhooks ?? { limit: 600, windowMs: 60_000 });
  // Browsers never need the API directly — the console calls it from its server —
  // but if one does, it is only from the console's own origin.
  await app.register(cors, { origin: [deps.webOrigin], credentials: false });

  app.get('/health', async () => ({ status: 'ok', at: new Date().toISOString() }));

  const billingDeps = { db: deps.db, billing: deps.billing ?? null, webOrigin: deps.webOrigin };
  const billing = new BillingService(billingDeps);
  await app.register(async (scoped) => registerPublicBillingRoutes(scoped, billing));

  const session = sessionGuard(deps.db, deps.sessionSecret);
  const internal = internalGuard(deps.sessionSecret);

  await app.register(async (scoped) => {
    scoped.addHook('preHandler', session);
    // After the session guard, so the key is the person it established.
    scoped.addHook('preHandler', rateLimitHook(consoleLimiter, (r) => (r.auth ? `user:${r.auth.userId}` : null)));
    await registerConsoleRoutes(scoped, { db: deps.db });
    await registerCredentialRoutes(scoped, { vault: deps.vault, log: (line) => app.log.info(line) });
    await registerGitHubRoutes(scoped, { db: deps.db, sessionSecret: deps.sessionSecret, github: deps.github ?? null });
    await registerSlackRoutes(scoped, {
      db: deps.db,
      sessionSecret: deps.sessionSecret,
      vault: deps.vault,
      slack: deps.slack?.client ?? null,
      redirectUri: deps.slack?.redirectUri ?? `${deps.webOrigin}/onboarding/slack/callback`,
    });
    await registerBillingRoutes(scoped, billing, billingDeps);
    await registerConfigRoutes(scoped, {
      db: deps.db,
      vault: deps.vault,
      github: deps.github ?? null,
      slack: deps.slack?.client ?? null,
      ...(deps.configPolicy ? { policy: deps.configPolicy } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
  });
  // Callers that are not the console: authenticated by their own signatures.
  await app.register(async (scoped) => {
    // Before the signature is checked, so a flood is turned away cheaply.
    scoped.addHook('onRequest', rateLimitHook(webhookLimiter, (r) => `ip:${r.ip}`));
    await registerGitHubWebhook(scoped, { db: deps.db, github: deps.github ?? null });
    await registerSentryWebhook(scoped, { db: deps.db, vault: deps.vault });
    await registerDodoWebhook(scoped, billing, (line) => app.log.info(line));
  });
  await app.register(async (scoped) => {
    scoped.addHook('preHandler', internal);
    await registerInternalRoutes(scoped, { db: deps.db });
  });
  return app;
}
