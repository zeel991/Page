import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, plans } from '@pager/db';
import { harness, healthServer, installThroughGitHub, installThroughSlack, onboard, type Harness } from './harness.ts';

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

describe('integrations', () => {
  it('refuses to send Datadog keys anywhere but Datadog', async () => {
    const s = await h.signIn('octo', '1001');
    const res = await h.call('PUT', '/api/integrations/datadog', s.token, { site: 'https://evil.example', apiKey: 'x'.repeat(20), appKey: 'y'.repeat(20) });
    expect(res.statusCode).toBe(422);
    expect(await h.vault.reveal(s.org, 'datadog.api_key')).toBeNull();
  });

  it('tests Datadog with the stored keys, and records the outcome', async () => {
    const s = await h.signIn('octo', '1001');
    await h.call('PUT', '/api/integrations/datadog', s.token, { site: h.endpoints.datadog, apiKey: 'dd-api-key-0123456789', appKey: 'dd-app-key-0123456789' });
    const ok = (await h.call('POST', '/api/integrations/datadog/test', s.token)).json() as { result: { ok: boolean } };
    expect(ok.result.ok).toBe(true);
    const status = (await h.call('GET', '/api/integrations', s.token)).json() as { datadog: { verifiedAt: string | null; keys: { last4: string }[] } };
    expect(status.datadog.verifiedAt).not.toBeNull();
    expect(status.datadog.keys.map((k) => k.last4).sort()).toEqual(['…6789', '…6789']);

    // A bad key is reported as the vendor's refusal, and the verification is not kept.
    await h.call('PUT', '/api/integrations/datadog', s.token, { site: h.endpoints.datadog, apiKey: 'dd-invalid-key-000000' });
    const bad = (await h.call('POST', '/api/integrations/datadog/test', s.token)).json() as { result: { ok: boolean; error: string } };
    expect(bad.result).toEqual({ ok: false, error: 'the vendor refused the credential (403)' });
  });

  it('tests Notion, Resend, Slack and GitHub connections', async () => {
    const s = await h.signIn('octo', '1001');
    await h.call('PUT', '/api/integrations/notion', s.token, { token: 'secret_notion_token' });
    await h.call('PUT', '/api/integrations/resend', s.token, { apiKey: 're_resend_key_1234', from: 'pager@acme.dev' });
    expect(((await h.call('POST', '/api/integrations/notion/test', s.token)).json() as { result: { ok: boolean } }).result.ok).toBe(true);
    expect(((await h.call('POST', '/api/integrations/resend/test', s.token)).json() as { result: { ok: boolean } }).result.ok).toBe(true);
    expect(((await h.call('POST', '/api/integrations/slack/test', s.token)).json() as { result: { ok: boolean } }).result.ok).toBe(false);
    const { url: sl } = (await h.call('GET', '/api/slack/install-url', s.token)).json() as { url: string };
    await h.call('POST', '/api/slack/oauth', s.token, await installThroughSlack(sl));
    expect(((await h.call('POST', '/api/integrations/slack/test', s.token)).json() as { result: { ok: boolean } }).result.ok).toBe(true);
    const { url: gh } = (await h.call('GET', '/api/github/install-url', s.token)).json() as { url: string };
    await h.call('POST', '/api/github/setup', s.token, await installThroughGitHub(gh));
    expect(((await h.call('POST', '/api/integrations/github/test', s.token)).json() as { result: { ok: boolean } }).result.ok).toBe(true);
  });
});

describe('services', () => {
  // These are about validation: room for more services than the free plan allows,
  // so a refusal here is the validator's, never the plan limit's (onboarding.test.ts).
  beforeEach(async () => {
    await h.handle.db.update(plans).set({ maxServices: 10 }).where(eq(plans.id, 'free'));
  });

  it('saves a service only when everything it names exists in the workspace', async () => {
    const { session, service } = await onboard(h, { healthUrl: health.url });
    const list = (await h.call('GET', '/api/services', session.token)).json() as { services: { id: string; enabled: boolean; slackChannelId: string }[] };
    expect(list.services).toEqual([expect.objectContaining({ id: service.id, enabled: true, slackChannelId: '#incidents' })]);
  });

  it.each([
    [{ intervalSeconds: 5 }, 'intervalSeconds'],
    [{ intervalSeconds: 1.5 }, 'intervalSeconds'],
    [{ autonomyLevel: 'L1' }, 'autonomyLevel'],
    [{ name: 'checkout api OR service:x' }, 'name'],
    [{ slackChannelId: '' }, 'slackChannelId'],
    [{ emailRecipients: ['not-an-email'] }, 'emailRecipients.0'],
  ])('refuses %j', async (patch, field) => {
    const { session, repositoryId } = await onboard(h, { healthUrl: health.url });
    const res = await h.call('POST', '/api/services', session.token, {
      name: 'other-svc', repositoryId, healthUrl: health.url, slackChannelId: '#incidents', ...patch,
    });
    expect(res.statusCode).toBe(422);
    expect(Object.keys((res.json() as { problems: Record<string, string> }).problems)).toContain(field);
  });

  it('refuses a second service with the same name, as a field problem rather than a server error', async () => {
    const { session, repositoryId } = await onboard(h, { healthUrl: health.url });
    const res = await h.call('POST', '/api/services', session.token, { name: 'checkout-api', repositoryId, healthUrl: health.url, slackChannelId: '#incidents' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ problems: { name: 'this workspace already has a service with this name' } });
  });

  it('refuses a channel the Slack bot cannot see, and a repository from another workspace', async () => {
    const { session, repositoryId } = await onboard(h, { healthUrl: health.url });
    const noChannel = await h.call('POST', '/api/services', session.token, { name: 'x', repositoryId, healthUrl: health.url, slackChannelId: '#nowhere' });
    expect((noChannel.json() as { problems: Record<string, string> }).problems.slackChannelId).toMatch(/cannot see/);
    const other = await h.signIn('bob', '1002');
    const foreign = await h.call('POST', '/api/services', other.token, { name: 'x', repositoryId, healthUrl: health.url, slackChannelId: '#incidents' });
    expect((foreign.json() as { problems: Record<string, string> }).problems.repositoryId).toBeDefined();
  });

  it('refuses a plain-http health URL from a tenant', async () => {
    const strict = await harness({ configPolicy: { allowDatadogUrl: () => true } });
    try {
      const s = await strict.signIn('octo', '1001');
      const res = await strict.call('POST', '/api/services', s.token, {
        name: 'svc', repositoryId: '00000000-0000-4000-8000-000000000000', healthUrl: 'http://10.0.0.5/health', slackChannelId: 'C1',
      });
      expect((res.json() as { problems: Record<string, string> }).problems.healthUrl).toMatch(/https/);
    } finally {
      await strict.close();
    }
  });

  it('tests the health URL with the probe the worker uses', async () => {
    const { session, service } = await onboard(h, { healthUrl: health.url });
    const res = (await h.call('POST', `/api/services/${service.id}/test-health`, session.token)).json() as { result: { ok: boolean; detail: string } };
    expect(res.result).toEqual({ ok: true, detail: 'reports revision abc1234def56' });
  });
});
