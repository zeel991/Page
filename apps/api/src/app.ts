import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { CredentialVault, Database } from '@pager/db';
import type { GitHubAppClient } from '@pager/providers';
import { registerCredentialRoutes } from './credential-routes.ts';
import { registerGitHubRoutes, registerGitHubWebhook } from './github-routes.ts';
import { internalGuard, sessionGuard } from './auth.ts';
import { registerInternalRoutes } from './internal-routes.ts';
import { registerConsoleRoutes } from './routes.ts';

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
  logLevel?: string;
}

/**
 * The API, assembled. Separate from `main.ts` so tests can drive it with `inject`.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: deps.logLevel ?? 'warn' } });
  // Browsers never need the API directly — the console calls it from its server —
  // but if one does, it is only from the console's own origin.
  await app.register(cors, { origin: [deps.webOrigin], credentials: false });

  app.get('/health', async () => ({ status: 'ok', at: new Date().toISOString() }));

  const session = sessionGuard(deps.db, deps.sessionSecret);
  const internal = internalGuard(deps.sessionSecret);

  await app.register(async (scoped) => {
    scoped.addHook('preHandler', session);
    await registerConsoleRoutes(scoped, { db: deps.db });
    await registerCredentialRoutes(scoped, { vault: deps.vault, log: (line) => app.log.info(line) });
    await registerGitHubRoutes(scoped, { db: deps.db, sessionSecret: deps.sessionSecret, github: deps.github ?? null });
  });
  // Callers that are not the console: authenticated by their own signatures.
  await app.register(async (scoped) => {
    await registerGitHubWebhook(scoped, { db: deps.db, github: deps.github ?? null });
  });
  await app.register(async (scoped) => {
    scoped.addHook('preHandler', internal);
    await registerInternalRoutes(scoped, { db: deps.db });
  });
  return app;
}
