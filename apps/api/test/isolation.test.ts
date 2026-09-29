import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { signToken } from '@pager/core';
import {
  IdentityRepository,
  agentRuns,
  createDatabase,
  deployments,
  evidence,
  incidents,
  migrate,
  services,
  telemetrySnapshots,
  toolCalls,
  type DatabaseHandle,
} from '@pager/db';
import { buildApp } from '../src/app.ts';

/**
 * Two workspaces, each with data in every table the console reads. Every route is
 * called as a member of A, both for A's own records and for B's. B's must never
 * appear, and fetching one by id must be a 404 — not a 403, which would confirm it
 * exists.
 */

const SECRET = 'test-session-secret-0123456789abcdef';
let handle: DatabaseHandle;
let app: FastifyInstance;
let a: Awaited<ReturnType<typeof tenant>>;
let b: Awaited<ReturnType<typeof tenant>>;

async function tenant(login: string, subject: string) {
  const identity = new IdentityRepository(handle.db);
  const { user, workspaces } = await identity.signIn({ provider: 'github', subject, login, email: null, name: login, avatarUrl: null });
  const org = workspaces[0]!.id;
  const [svc] = await handle.db.insert(services).values({ organizationId: org, name: `${login}-svc` }).returning();
  const [dep] = await handle.db.insert(deployments).values({
    organizationId: org, serviceId: svc!.id, repositoryId: (await repo(org, login)).id,
    environment: 'production', status: 'succeeded', commitSha: `${login}sha`, startedAt: new Date(),
  }).returning();
  const [inc] = await handle.db.insert(incidents).values({
    organizationId: org, serviceId: svc!.id, key: 'INC-1', state: 'INVESTIGATING', severity: 'SEV2',
    title: `${login} incident`, suspectedDeploymentId: dep!.id,
  }).returning();
  const runId = crypto.randomUUID();
  await handle.db.insert(agentRuns).values({ id: runId, organizationId: org, incidentId: inc!.id, agentName: `${login}Agent`, status: 'OK', startedAt: new Date() });
  const callId = crypto.randomUUID();
  await handle.db.insert(toolCalls).values({ id: callId, organizationId: org, agentRunId: runId, incidentId: inc!.id, toolName: `${login}.tool`, status: 'OK', durationMs: 1, startedAt: new Date() });
  await handle.db.insert(evidence).values({ organizationId: org, incidentId: inc!.id, kind: 'K', provenance: 'OBSERVED', summary: `${login} evidence`, sourceToolCallId: callId });
  await handle.db.insert(telemetrySnapshots).values({
    organizationId: org, serviceId: svc!.id, metric: 'error_rate', windowKind: 'baseline',
    windowFrom: new Date(), windowTo: new Date(), unit: 'ratio', sampleCount: 1, points: [],
  });
  return {
    userId: user.id, org, incident: inc!.id, deployment: dep!.id, service: svc!.id,
    token: signToken(SECRET, 'api-session', { sub: user.id, org }, 300),
  };
}

async function repo(org: string, login: string) {
  const { repositories } = await import('@pager/db');
  const [row] = await handle.db.insert(repositories).values({ organizationId: org, fullName: `${login}/app` }).returning();
  return row!;
}

const get = (url: string, token?: string) =>
  app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });

beforeEach(async () => {
  handle = await createDatabase('pglite://memory');
  await migrate(handle);
  app = await buildApp({ db: handle.db, sessionSecret: SECRET, webOrigin: 'http://console.test' });
  a = await tenant('alice', '1001');
  b = await tenant('bob', '1002');
});

afterEach(async () => {
  await app.close();
  await handle.close();
});

describe('workspace isolation', () => {
  it.each([
    ['incident', () => `/api/incidents/${b.incident}`],
    ['deployment', () => `/api/deployments/${b.deployment}`],
  ])('answers 404 for another workspace’s %s', async (_label, url) => {
    const res = await get(url(), a.token);
    expect(res.statusCode).toBe(404);
    // And the same route works for the caller's own record.
    const own = await get(url().replace(b.incident, a.incident).replace(b.deployment, a.deployment), a.token);
    expect(own.statusCode).toBe(200);
  });

  it.each(['/api/overview', '/api/incidents', '/api/deployments', '/api/services', '/api/policies', '/api/agent-runs', '/api/me'])(
    'shows nothing of another workspace in %s',
    async (url) => {
      const res = await get(url, a.token);
      expect(res.statusCode).toBe(200);
      const body = res.body;
      for (const foreign of [b.org, b.incident, b.deployment, b.service, 'bob incident', 'bob-svc', 'bobAgent', 'bob.tool', 'bobsha']) {
        expect(body).not.toContain(foreign);
      }
    },
  );

  it('keeps an incident page’s evidence, runs and telemetry inside its workspace', async () => {
    const res = await get(`/api/incidents/${a.incident}`, a.token);
    const detail = res.json() as { evidence: unknown[]; agentRuns: unknown[]; telemetry: unknown[] };
    expect(detail.evidence).toHaveLength(1);
    expect(detail.agentRuns).toHaveLength(1);
    expect(detail.telemetry).toHaveLength(1);
    expect(res.body).not.toContain('bob');
  });

  it('refuses a session that names a workspace the user does not belong to', async () => {
    // A validly signed token cannot pull someone into a workspace: membership is re-read.
    const forged = signToken(SECRET, 'api-session', { sub: a.userId, org: b.org }, 300);
    expect((await get('/api/incidents', forged)).statusCode).toBe(401);
  });

  it('refuses no token, a foreign signature, and an internal token', async () => {
    expect((await get('/api/incidents')).statusCode).toBe(401);
    const foreign = signToken('another-secret-0123456789abcdefghij', 'api-session', { sub: a.userId, org: a.org }, 300);
    expect((await get('/api/incidents', foreign)).statusCode).toBe(401);
    const internal = signToken(SECRET, 'internal', {}, 300);
    expect((await get('/api/incidents', internal)).statusCode).toBe(401);
  });

  it('only lets the console’s own origin call it from a browser', async () => {
    const res = await app.inject({ method: 'OPTIONS', url: '/api/incidents', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const ok = await app.inject({ method: 'OPTIONS', url: '/api/incidents', headers: { origin: 'http://console.test', 'access-control-request-method': 'GET' } });
    expect(ok.headers['access-control-allow-origin']).toBe('http://console.test');
  });
});

describe('sign-in', () => {
  const internal = () => signToken(SECRET, 'internal', {}, 60);

  it('creates a workspace, owned by the person, the first time they sign in', async () => {
    const res = await app.inject({
      method: 'POST', url: '/internal/sign-in', headers: { authorization: `Bearer ${internal()}` },
      payload: { provider: 'github', subject: '2001', login: 'carol', email: null, name: 'Carol', avatarUrl: null },
    });
    const body = res.json() as { created: boolean; workspaces: { role: string; name: string }[] };
    expect(body.created).toBe(true);
    expect(body.workspaces).toEqual([expect.objectContaining({ role: 'owner', name: "carol's workspace" })]);
    const again = await app.inject({
      method: 'POST', url: '/internal/sign-in', headers: { authorization: `Bearer ${internal()}` },
      payload: { provider: 'github', subject: '2001', login: 'carol-renamed', email: null, name: 'Carol', avatarUrl: null },
    });
    // Same GitHub id, same person: no second workspace.
    expect((again.json() as { created: boolean; workspaces: unknown[] }).workspaces).toHaveLength(1);
  });

  it('is not callable with a session token', async () => {
    const res = await app.inject({ method: 'POST', url: '/internal/sign-in', headers: { authorization: `Bearer ${a.token}` }, payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('gives a new workspace its policies and L3 autonomy', async () => {
    const res = await get('/api/policies', a.token);
    const body = res.json() as { autonomyLevel: string; policies: { name: string }[] };
    expect(body.autonomyLevel).toBe('L3');
    expect(body.policies.map((p) => p.name)).toContain('Merge a pull request');
  });
});
