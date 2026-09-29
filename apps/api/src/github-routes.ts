import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { InvalidTokenError, signToken, verifyToken } from '@pager/core';
import { InstallationClaimedError, InstallationRepository, type Database } from '@pager/db';
import { GitHubInstallError, type GitHubAppClient } from '@pager/providers';
import { auth, requireRole } from './auth.ts';

/**
 * Connecting a workspace to GitHub: install the app, prove the installation is the
 * installer's to connect, and pick repositories from it.
 *
 * The setup callback carries an installation id in the URL, so on its own it would
 * let anyone who can guess an id attach someone else's installation — and its
 * repositories — to their workspace. It is accepted only when:
 *
 *  1. `state` is one this API signed, for this workspace and this person, and
 *     unexpired (so a callback cannot be replayed into another workspace); and
 *  2. GitHub itself, asked with the installer's own user-to-server token (from the
 *     OAuth code GitHub appends during install), lists the installation among those
 *     that person can access.
 */

const INSTALL_STATE_TTL_SECONDS = 15 * 60;

const Setup = z.object({
  installationId: z.coerce.number().int().positive(),
  state: z.string().min(1),
  code: z.string().min(1),
});
const AddRepository = z.object({ fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/) });

export interface GitHubRouteDeps {
  db: Database;
  sessionSecret: string;
  /** Null when the operator has not configured a GitHub App; routes then answer 503. */
  github: GitHubAppClient | null;
}

export async function registerGitHubRoutes(app: FastifyInstance, deps: GitHubRouteDeps): Promise<void> {
  const installations = new InstallationRepository(deps.db);
  const unavailable = { error: 'github_app_not_configured', reason: 'This deployment has no GitHub App configured.' };

  app.get('/api/github/install-url', async (request, reply) => {
    if (!deps.github) return reply.code(503).send(unavailable);
    if (!requireRole(request, reply, ['owner', 'admin'])) return reply;
    const a = auth(request);
    const state = signToken(deps.sessionSecret, 'github-install', { org: a.organizationId, sub: a.userId }, INSTALL_STATE_TTL_SECONDS);
    return { url: deps.github.installUrl(state) };
  });

  app.post('/api/github/setup', async (request, reply) => {
    if (!deps.github) return reply.code(503).send(unavailable);
    if (!requireRole(request, reply, ['owner', 'admin'])) return reply;
    const parsed = Setup.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'installation_id, state and code are required' });
    const a = auth(request);
    const { installationId, state, code } = parsed.data;

    try {
      const claims = verifyToken<{ org?: string; sub?: string }>(deps.sessionSecret, 'github-install', state);
      if (claims.org !== a.organizationId || claims.sub !== a.userId) {
        return reply.code(400).send({ error: 'state_mismatch', reason: 'This install was started from a different workspace or by a different person.' });
      }
    } catch (err) {
      return reply.code(400).send({ error: 'invalid_state', reason: err instanceof InvalidTokenError ? err.message : 'invalid state' });
    }

    try {
      const userToken = await deps.github.exchangeCode(code);
      const visible = await deps.github.userInstallationIds(userToken);
      if (!visible.includes(installationId)) {
        return reply.code(403).send({ error: 'not_your_installation', reason: `GitHub does not list installation ${installationId} among those you can access.` });
      }
      const info = await deps.github.installation(installationId);
      const row = await installations.bind({
        organizationId: a.organizationId,
        installationId,
        accountLogin: info.accountLogin,
        accountType: info.accountType,
        repositorySelection: info.repositorySelection,
        installedByUserId: a.userId,
      });
      return { installation: row };
    } catch (err) {
      if (err instanceof InstallationClaimedError) return reply.code(409).send({ error: 'installation_claimed', reason: err.message });
      if (err instanceof GitHubInstallError) return reply.code(400).send({ error: 'github_refused', reason: err.message });
      throw err;
    }
  });

  app.get('/api/github/installations', async (request) => ({
    installations: await installations.forOrganization(auth(request).organizationId),
  }));

  /** Repositories the workspace's installations cover, marked with which are picked. */
  app.get('/api/github/repositories', async (request, reply) => {
    if (!deps.github) return reply.code(503).send(unavailable);
    const org = auth(request).organizationId;
    const picked = new Set((await installations.repositories(org)).filter((r) => !r.detachedAt).map((r) => r.fullName));
    const out: { fullName: string; defaultBranch: string; private: boolean; installation: string; picked: boolean }[] = [];
    for (const inst of await installations.active(org)) {
      for (const repo of await deps.github.installationRepositories(inst.installationId)) {
        out.push({ ...repo, installation: inst.id, picked: picked.has(repo.fullName) });
      }
    }
    return { repositories: out };
  });

  app.get('/api/repositories', async (request) => ({
    repositories: (await installations.repositories(auth(request).organizationId)).filter((r) => !r.detachedAt),
  }));

  /** Pick a repository. It must be covered by one of this workspace's own installations. */
  app.post('/api/repositories', async (request, reply) => {
    if (!deps.github) return reply.code(503).send(unavailable);
    if (!requireRole(request, reply, ['owner', 'admin'])) return reply;
    const parsed = AddRepository.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'fullName must be owner/name' });
    const org = auth(request).organizationId;
    for (const inst of await installations.active(org)) {
      const repo = (await deps.github.installationRepositories(inst.installationId)).find((r) => r.fullName === parsed.data.fullName);
      if (repo) {
        const row = await installations.addRepository({
          organizationId: org,
          githubInstallationId: inst.id,
          fullName: repo.fullName,
          defaultBranch: repo.defaultBranch,
        });
        return { repository: row };
      }
    }
    return reply.code(404).send({ error: 'not_installed', reason: `${parsed.data.fullName} is not covered by this workspace's GitHub installation.` });
  });

  app.delete<{ Params: { id: string } }>('/api/repositories/:id', async (request, reply) => {
    if (!requireRole(request, reply, ['owner', 'admin'])) return reply;
    const removed = await installations.removeRepository(auth(request).organizationId, request.params.id);
    return removed ? { removed: request.params.id } : reply.code(404).send({ error: 'Repository not found' });
  });
}

/**
 * GitHub's webhooks. Not behind a session: GitHub is the caller, and the only
 * credential is the HMAC signature over the exact bytes it sent. Unsigned or
 * mis-signed deliveries are refused before the payload is read.
 *
 * Only access-narrowing events are acted on — an uninstall, a suspension, a
 * repository removed from the installation. Adding access always goes through a
 * person, in the console.
 */
export async function registerGitHubWebhook(app: FastifyInstance, deps: { db: Database; github: GitHubAppClient | null }): Promise<void> {
  const installations = new InstallationRepository(deps.db);
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.post('/webhooks/github', async (request, reply) => {
    if (!deps.github) return reply.code(503).send({ error: 'github_app_not_configured' });
    const raw = typeof request.body === 'string' ? request.body : '';
    if (!deps.github.verifyWebhook(raw, request.headers['x-hub-signature-256'] as string | undefined)) {
      return reply.code(401).send({ error: 'bad_signature' });
    }
    let payload: {
      action?: string;
      installation?: { id?: number };
      repositories_removed?: { full_name?: string }[];
    };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      return reply.code(400).send({ error: 'unreadable payload' });
    }
    const event = request.headers['x-github-event'];
    const installationId = payload.installation?.id;
    if (typeof installationId !== 'number') return { ignored: true };

    if (event === 'installation') {
      if (payload.action === 'deleted') await installations.markRemoved(installationId);
      else if (payload.action === 'suspend') await installations.setSuspended(installationId, true);
      else if (payload.action === 'unsuspend') await installations.setSuspended(installationId, false);
    } else if (event === 'installation_repositories' && payload.action === 'removed') {
      const names = (payload.repositories_removed ?? []).map((r) => r.full_name).filter((n): n is string => Boolean(n));
      await installations.detachRepositories(installationId, names);
    }
    return { ok: true };
  });
}
