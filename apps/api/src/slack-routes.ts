import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { InvalidTokenError, signToken, verifyToken } from '@pager/core';
import { IdentityRepository, SlackRepository, SlackTeamClaimedError, type CredentialVault, type Database } from '@pager/db';
import { SlackInstallError, type SlackAppClient } from '@pager/providers';
import { auth, requireRole } from './auth.ts';

/**
 * Connecting a workspace to Slack (OAuth v2), picking a channel, and linking members'
 * Slack identities so a merge click can be attributed to a person with the right
 * role.
 *
 * The bot token is written straight from the OAuth exchange into the vault. It never
 * passes through a form, and the API never returns it.
 */

const STATE_TTL_SECONDS = 15 * 60;
const Callback = z.object({ code: z.string().min(1), state: z.string().min(1) });
const Link = z.object({ slackUserId: z.string().regex(/^[UW][A-Z0-9]+$/).nullable() });

export interface SlackRouteDeps {
  db: Database;
  sessionSecret: string;
  vault: CredentialVault;
  slack: SlackAppClient | null;
  /** Where Slack sends the browser back: the console's callback page. */
  redirectUri: string;
}

export async function registerSlackRoutes(app: FastifyInstance, deps: SlackRouteDeps): Promise<void> {
  const repo = new SlackRepository(deps.db);
  const identity = new IdentityRepository(deps.db);
  const unavailable = { error: 'slack_app_not_configured', reason: 'This deployment has no Slack app configured.' };

  app.get('/api/slack/install-url', async (request, reply) => {
    if (!deps.slack) return reply.code(503).send(unavailable);
    if (!requireRole(request, reply, ['owner', 'admin'])) return reply;
    const a = auth(request);
    const state = signToken(deps.sessionSecret, 'slack-install', { org: a.organizationId, sub: a.userId }, STATE_TTL_SECONDS);
    return { url: deps.slack.authorizeUrl(state, deps.redirectUri) };
  });

  app.post('/api/slack/oauth', async (request, reply) => {
    if (!deps.slack) return reply.code(503).send(unavailable);
    if (!requireRole(request, reply, ['owner', 'admin'])) return reply;
    const parsed = Callback.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'code and state are required' });
    const a = auth(request);
    try {
      const claims = verifyToken<{ org?: string; sub?: string }>(deps.sessionSecret, 'slack-install', parsed.data.state);
      if (claims.org !== a.organizationId || claims.sub !== a.userId) {
        return reply.code(400).send({ error: 'state_mismatch', reason: 'This install was started from a different workspace or by a different person.' });
      }
    } catch (err) {
      return reply.code(400).send({ error: 'invalid_state', reason: err instanceof InvalidTokenError ? err.message : 'invalid state' });
    }

    try {
      const install = await deps.slack.exchangeCode(parsed.data.code, deps.redirectUri);
      const row = await repo.bind({
        organizationId: a.organizationId,
        teamId: install.teamId,
        teamName: install.teamName,
        botUserId: install.botUserId,
        installedByUserId: a.userId,
      });
      await deps.vault.put(a.organizationId, 'slack.bot_token', install.botToken);
      const linked = await linkByEmail(a.organizationId, install.botToken);
      return { installation: { teamId: row.teamId, teamName: row.teamName }, linkedMembers: linked };
    } catch (err) {
      if (err instanceof SlackTeamClaimedError) return reply.code(409).send({ error: 'team_claimed', reason: err.message });
      if (err instanceof SlackInstallError) return reply.code(400).send({ error: 'slack_refused', reason: err.message });
      throw err;
    }
  });

  app.get('/api/slack', async (request) => {
    const row = await repo.forOrganization(auth(request).organizationId);
    return { installation: row ? { teamId: row.teamId, teamName: row.teamName, createdAt: row.createdAt } : null };
  });

  app.get('/api/slack/channels', async (request, reply) => {
    if (!deps.slack) return reply.code(503).send(unavailable);
    const token = await deps.vault.reveal(auth(request).organizationId, 'slack.bot_token');
    if (!token) return reply.code(409).send({ error: 'slack_not_connected' });
    return { channels: await deps.slack.channels(token) };
  });

  app.get('/api/members', async (request) => {
    const members = await identity.members(auth(request).organizationId);
    return {
      members: members.map((m) => ({ id: m.id, role: m.role, slackUserId: m.slackUserId, login: m.user.login, name: m.user.name })),
    };
  });

  /** Link a member's Slack id by hand, when their GitHub email does not match Slack's. */
  app.put<{ Params: { id: string } }>('/api/members/:id/slack', async (request, reply) => {
    if (!requireRole(request, reply, ['owner'])) return reply;
    const parsed = Link.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'slackUserId must be a Slack user id, or null' });
    const ok = await repo.linkMember(auth(request).organizationId, request.params.id, parsed.data.slackUserId);
    return ok ? { linked: parsed.data.slackUserId } : reply.code(404).send({ error: 'Member not found' });
  });

  /** Match each member with a known email to their Slack user. Returns how many linked. */
  async function linkByEmail(organizationId: string, botToken: string): Promise<number> {
    let linked = 0;
    for (const m of await identity.members(organizationId)) {
      if (!m.user.email || m.slackUserId) continue;
      const slackUserId = await deps.slack!.userIdByEmail(botToken, m.user.email);
      if (slackUserId && (await repo.linkMember(organizationId, m.id, slackUserId))) linked++;
    }
    return linked;
  }
}
