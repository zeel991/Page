import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { JobQueue, ServiceConfigRepository, type CredentialVault, type Database } from '@pager/db';

/**
 * Sentry's webhooks: the push half of an alert source.
 *
 * A signed delivery about a project a workspace watches through Sentry wakes that
 * service's poll now instead of at its next interval. It does not bypass the poll:
 * the decision to open an incident is made the same way, from the same reads, as
 * when nothing was pushed — a webhook carries nothing a poll does not re-read.
 *
 * `Sentry-Hook-Signature` is an HMAC-SHA256 of the exact body with the
 * integration's client secret. A delivery is matched to the workspaces watching its
 * project, and counts only for the one whose secret signed it.
 */
export async function registerSentryWebhook(app: FastifyInstance, deps: { db: Database; vault: CredentialVault }): Promise<void> {
  const services = new ServiceConfigRepository(deps.db);
  const queue = new JobQueue(deps.db, { workerId: 'api' });

  app.post('/webhooks/sentry', async (request, reply) => {
    const raw = typeof request.body === 'string' ? request.body : '';
    const signature = String(request.headers['sentry-hook-signature'] ?? '');
    let payload: { data?: { issue?: { project?: { slug?: string } }; event?: { project?: string | number } } };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      return reply.code(400).send({ error: 'unreadable payload' });
    }
    const project = payload.data?.issue?.project?.slug;
    if (!signature || !project) return reply.code(401).send({ error: 'unsigned, or not about a project' });

    const watching = (await services.enabledWithRepository()).filter((r) => r.service.alertSource === 'sentry' && r.service.name === project);
    let woke = 0;
    for (const { service } of watching) {
      const secret = await deps.vault.reveal(service.organizationId, 'sentry.webhook_secret');
      if (!secret || !signedBy(raw, signature, secret)) continue;
      if (await queue.expedite(`poll:${service.id}`)) woke++;
    }
    // The same answer whether or not a workspace matched, so a caller cannot probe
    // which projects are watched.
    return { ok: true, ...(woke ? { woke } : {}) };
  });
}

function signedBy(body: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
