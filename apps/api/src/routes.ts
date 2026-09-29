import type { FastifyInstance } from 'fastify';
import { ConsoleReads, IdentityRepository, type Database } from '@pager/db';
import { auth } from './auth.ts';

/**
 * The console's read API.
 *
 * Every route here is behind the session guard and reads through `ConsoleReads`,
 * which is constructed with the caller's workspace and cannot see outside it. A
 * record in another workspace is a 404, indistinguishable from one that never
 * existed.
 */

export interface RouteDeps {
  db: Database;
}

export async function registerConsoleRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { db } = deps;
  const reads = (request: Parameters<typeof auth>[0]) => new ConsoleReads(db, auth(request).organizationId);
  const identity = new IdentityRepository(db);

  app.get('/api/me', async (request) => {
    const a = auth(request);
    const user = await identity.user(a.userId);
    return {
      user: user ? { id: user.id, login: user.login, name: user.name, email: user.email, avatarUrl: user.avatarUrl } : null,
      organizationId: a.organizationId,
      role: a.role,
      workspaces: await identity.workspacesFor(a.userId),
    };
  });

  /** Overview: production health at a glance. */
  app.get('/api/overview', async (request) => reads(request).overview());

  app.get('/api/incidents', async (request) => ({ incidents: await reads(request).incidents() }));

  /** The incident page: everything known about one incident, in one payload. */
  app.get<{ Params: { id: string } }>('/api/incidents/:id', async (request, reply) => {
    const detail = await reads(request).incidentDetail(request.params.id);
    if (!detail) return reply.code(404).send({ error: 'Incident not found' });
    return detail;
  });

  app.get('/api/deployments', async (request) => ({ deployments: await reads(request).deployments() }));

  app.get<{ Params: { id: string } }>('/api/deployments/:id', async (request, reply) => {
    const found = await reads(request).deployment(request.params.id);
    if (!found) return reply.code(404).send({ error: 'Deployment not found' });
    return found;
  });

  app.get('/api/services', async (request) => ({ services: await reads(request).services() }));

  /** What this workspace permits, read from its own rows rather than a static page. */
  app.get('/api/policies', async (request) => {
    const r = reads(request);
    const org = await r.organization();
    return { autonomyLevel: org?.autonomyLevel ?? null, policies: await r.policies() };
  });

  /** Agent observability: every run, and how its tool calls went. */
  app.get('/api/agent-runs', async (request) => reads(request).agentRunStats());
}
