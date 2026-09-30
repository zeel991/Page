import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, jobs, plans } from '@pager/db';
import { JobQueue } from '@pager/db';
import { harness, healthServer, onboard, type Harness } from './harness.ts';

let h: Harness;
let health: Awaited<ReturnType<typeof healthServer>>;
beforeEach(async () => {
  h = await harness();
  health = await healthServer(() => 'abc1234def5678');
});
afterEach(async () => {
  await health.close();
  await h.close();
});

const SECRET = 'sentry-client-secret-0123456789';
const connect = (token: string, over: Record<string, unknown> = {}) =>
  h.call('PUT', '/api/integrations/sentry', token, { baseUrl: h.endpoints.sentry, organization: 'acme', token: 'sntrys_0123456789abcdef', webhookSecret: SECRET, ...over });

describe('Sentry as an integration', () => {
  it('refuses to send a Sentry token anywhere but Sentry', async () => {
    const s = await h.signIn('octo', '1001');
    const res = await connect(s.token, { baseUrl: 'https://evil.example' });
    expect(res.statusCode).toBe(422);
    expect(await h.vault.reveal(s.org, 'sentry.auth_token')).toBeNull();
  });

  it('tests the connection with the stored token, against Sentry’s API', async () => {
    const s = await h.signIn('octo', '1001');
    expect((await connect(s.token)).statusCode).toBe(200);
    const test = (await h.call('POST', '/api/integrations/sentry/test', s.token)).json() as { result: { ok: boolean; detail?: string } };
    expect(test.result).toMatchObject({ ok: true, detail: 'token can read organization acme' });
    const listing = (await h.call('GET', '/api/integrations', s.token)).json() as { sentry: { configured: boolean; verifiedAt: string | null } };
    expect(listing.sentry).toMatchObject({ configured: true });
    expect(listing.sentry.verifiedAt).not.toBeNull();
  });

  it('watches a service through Sentry only once Sentry is connected', async () => {
    const { session, repositoryId } = await onboard(h, { healthUrl: health.url });
    await h.handle.db.update(plans).set({ maxServices: 10 }).where(eq(plans.id, 'free'));
    const body = { name: 'checkout-web', repositoryId, healthUrl: health.url, slackChannelId: '#incidents', alertSource: 'sentry' };
    const refused = await h.call('POST', '/api/services', session.token, body);
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ problems: { alertSource: 'connect Sentry first' } });
    await connect(session.token);
    expect((await h.call('POST', '/api/services', session.token, body)).statusCode).toBe(200);
  });
});

describe('Sentry webhooks', () => {
  async function watchedThroughSentry() {
    const { session, service } = await onboard(h, { healthUrl: health.url });
    await connect(session.token);
    await h.call('PATCH', `/api/services/${service.id}`, session.token, { alertSource: 'sentry' });
    // A poll waiting for its next interval, an hour away.
    const queue = new JobQueue(h.handle.db, { workerId: 'test' });
    await queue.enqueue({ organizationId: session.org, serviceId: service.id, kind: 'poll', dedupeKey: `poll:${service.id}`, runAt: new Date(Date.now() + 3_600_000) });
    return service;
  }
  const deliver = (body: string, signature: string | null) =>
    h.app.inject({ method: 'POST', url: '/webhooks/sentry', headers: { 'content-type': 'application/json', ...(signature ? { 'sentry-hook-signature': signature } : {}) }, payload: body });
  const pollRunAt = async (serviceId: string) =>
    (await h.handle.db.select().from(jobs).where(eq(jobs.dedupeKey, `poll:${serviceId}`)))[0]!.runAt.getTime();

  it('wakes the watched service’s poll for a correctly signed delivery', async () => {
    const service = await watchedThroughSentry();
    const body = JSON.stringify({ action: 'created', data: { issue: { id: '1', project: { slug: 'checkout-api' } } } });
    const res = await deliver(body, createHmac('sha256', SECRET).update(body).digest('hex'));
    expect(res.json()).toMatchObject({ ok: true, woke: 1 });
    expect(await pollRunAt(service.id)).toBeLessThanOrEqual(Date.now());
  });

  it('does nothing for a delivery signed with another secret, or unsigned', async () => {
    const service = await watchedThroughSentry();
    const body = JSON.stringify({ action: 'created', data: { issue: { id: '1', project: { slug: 'checkout-api' } } } });
    const forged = await deliver(body, createHmac('sha256', 'someone-elses-secret-000000').update(body).digest('hex'));
    expect(forged.json()).toEqual({ ok: true });
    expect((await deliver(body, null)).statusCode).toBe(401);
    expect(await pollRunAt(service.id)).toBeGreaterThan(Date.now() + 3_000_000);
  });
});
