import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CredentialKind, CredentialVault } from '@pager/db';
import { auth, requireRole } from './auth.ts';

const KINDS = ['datadog.api_key', 'datadog.app_key', 'slack.bot_token', 'anthropic.api_key', 'notion.token', 'resend.api_key'] as const;
const Put = z.object({ secret: z.string().min(8).max(4096) });

/**
 * Secrets go in and never come out. The response to a write, and every read, carries
 * only the kind and the last four characters. Slack's bot token is written by the
 * OAuth callback, not here, so it is not accepted from a form.
 */
export async function registerCredentialRoutes(
  app: FastifyInstance,
  deps: { vault: CredentialVault; log: (line: string) => void },
): Promise<void> {
  app.get('/api/credentials', async (request) => ({ credentials: await deps.vault.describe(auth(request).organizationId) }));

  app.put<{ Params: { kind: string } }>('/api/credentials/:kind', async (request, reply) => {
    if (!requireRole(request, reply, ['owner', 'admin'])) return reply;
    const kind = request.params.kind as CredentialKind;
    if (!(KINDS as readonly string[]).includes(kind) || kind === 'slack.bot_token') {
      return reply.code(400).send({ error: `unknown or non-settable credential kind: ${kind}` });
    }
    const parsed = Put.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'secret must be 8–4096 characters' });
    const a = auth(request);
    const summary = await deps.vault.put(a.organizationId, kind, parsed.data.secret);
    deps.log(`credential ${kind} set for workspace ${a.organizationId} by ${a.userId} (${summary.last4})`);
    return { credential: summary };
  });

  app.delete<{ Params: { kind: string } }>('/api/credentials/:kind', async (request, reply) => {
    if (!requireRole(request, reply, ['owner', 'admin'])) return reply;
    await deps.vault.remove(auth(request).organizationId, request.params.kind as CredentialKind);
    return { removed: request.params.kind };
  });
}
