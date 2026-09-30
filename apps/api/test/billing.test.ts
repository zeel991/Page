import { afterEach, describe, expect, it } from 'vitest';
import { eq, organizations } from '@pager/db';
import { dodoFromEnv, signDodoWebhook } from '@pager/providers';
import { TWIN_DODO, completeDodoCheckout, dodoDelivery, setDodoSubscriptionStatus, type DodoDelivery } from '@pager/twin-local';
import { harness, type Harness } from './harness.ts';

/**
 * Paid plans end to end: the console's API, the Dodo Payments twin, and Dodo's
 * signed webhooks. The plan a workspace is on must follow only Dodo's own record of
 * its subscription.
 */
let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function withBilling() {
  h = await harness((e) => ({
    billing: dodoFromEnv({
      DODO_PAYMENTS_API_KEY: TWIN_DODO.apiKey,
      DODO_PAYMENTS_WEBHOOK_SECRET: TWIN_DODO.webhookSecret,
      DODO_PRODUCT_TEAM: TWIN_DODO.teamProduct,
      PAGER_DODO_URL: e.dodo,
    }),
  }));
  return h;
}

const deliver = (d: DodoDelivery) => h!.app.inject({ method: 'POST', url: '/webhooks/dodo', headers: d.headers, payload: d.body });
const planOf = async (org: string) => (await h!.handle.db.select({ plan: organizations.planId }).from(organizations).where(eq(organizations.id, org)))[0]!.plan;

async function checkout(token: string) {
  const res = await h!.call('POST', '/api/billing/checkout', token, { planId: 'team' });
  expect(res.statusCode).toBe(200);
  const url = (res.json() as { url: string }).url;
  return url.split('/').pop()!;
}

describe('billing', () => {
  it('shows each plan with the price Dodo states for it, and the free plan without one', async () => {
    await withBilling();
    const res = await h!.app.inject({ method: 'GET', url: '/public/plans' });
    const body = res.json() as { enabled: boolean; plans: { id: string; price: unknown; purchasable: boolean }[] };
    expect(body.enabled).toBe(true);
    expect(body.plans.find((p) => p.id === 'team')).toMatchObject({ purchasable: true, price: { amount: 4900, currency: 'USD', interval: 'Month', recurring: true } });
    expect(body.plans.find((p) => p.id === 'free')).toMatchObject({ purchasable: false, price: null });
  });

  it('upgrades a workspace once Dodo reports the subscription, whichever delivery arrives first', async () => {
    await withBilling();
    const s = await h!.signIn('octo', '1001', 'octo@acme.dev');
    const session = await checkout(s.token);
    expect(h!.twin.current.dodo.checkouts.get(session)).toMatchObject({ email: 'octo@acme.dev', metadata: { workspace_id: s.org, plan_id: 'team' } });

    // Dodo does not promise to copy checkout metadata onto the subscription; here it does not.
    const paid = completeDodoCheckout(h!.twin.current, session, { copyMetadata: false });
    const [payment, activation] = paid.deliveries;
    // The activation first, naming only the subscription: nothing yet ties it to a workspace.
    expect((await deliver(activation!)).json()).toMatchObject({ matched: false });
    expect(await planOf(s.org)).toBe('free');
    // The payment names the checkout session this API opened.
    expect((await deliver(payment!)).json()).toMatchObject({ matched: true, applied: true });
    expect(await planOf(s.org)).toBe('team');

    const billing = (await h!.call('GET', '/api/billing', s.token)).json() as { subscription: { status: string; manageable: boolean } };
    expect(billing.subscription).toMatchObject({ status: 'active', manageable: true });
    const portal = await h!.call('POST', '/api/billing/portal', s.token);
    expect((portal.json() as { url: string }).url).toMatch(/customer-portal|portal/);
  });

  it('refuses an unsigned, forged or stale delivery, and applies a retried one once', async () => {
    await withBilling();
    const s = await h!.signIn('octo', '1001');
    const paid = completeDodoCheckout(h!.twin.current, await checkout(s.token), { copyMetadata: true });
    const d = paid.deliveries[1]!;

    expect((await deliver({ headers: { 'content-type': 'application/json' }, body: d.body })).statusCode).toBe(401);
    const forged = { ...d.headers, 'webhook-signature': signDodoWebhook(`whsec_${Buffer.from('not-the-secret').toString('base64')}`, d.headers['webhook-id']!, Number(d.headers['webhook-timestamp']), d.body) };
    expect((await deliver({ headers: forged, body: d.body })).statusCode).toBe(401);
    const stale = dodoDelivery(h!.twin.current, 'subscription.active', JSON.parse(d.body).data, Date.now() - 10 * 60_000);
    expect((await deliver(stale)).statusCode).toBe(401);
    expect(await planOf(s.org)).toBe('free');

    // Copied metadata is enough to place it.
    expect((await deliver(d)).json()).toMatchObject({ applied: true });
    expect((await deliver(d)).json()).toMatchObject({ duplicate: true });
    expect(await planOf(s.org)).toBe('team');
  });

  it('follows the subscription down and up again: on hold ends the plan, a renewal restores it', async () => {
    await withBilling();
    const s = await h!.signIn('octo', '1001');
    const paid = completeDodoCheckout(h!.twin.current, await checkout(s.token));
    await deliver(paid.deliveries[0]!);
    expect(await planOf(s.org)).toBe('team');

    await deliver(setDodoSubscriptionStatus(h!.twin.current, paid.subscription.subscriptionId, 'past_due'));
    expect(await planOf(s.org)).toBe('team');
    await deliver(setDodoSubscriptionStatus(h!.twin.current, paid.subscription.subscriptionId, 'on_hold'));
    expect(await planOf(s.org)).toBe('free');
    await deliver(setDodoSubscriptionStatus(h!.twin.current, paid.subscription.subscriptionId, 'active', 'subscription.renewed'));
    expect(await planOf(s.org)).toBe('team');
    await deliver(setDodoSubscriptionStatus(h!.twin.current, paid.subscription.subscriptionId, 'cancelled'));
    expect(await planOf(s.org)).toBe('free');
  });

  it('does not let a late event about an old subscription undo a newer one', async () => {
    await withBilling();
    const s = await h!.signIn('octo', '1001');
    const first = completeDodoCheckout(h!.twin.current, await checkout(s.token));
    await deliver(first.deliveries[0]!);
    await deliver(setDodoSubscriptionStatus(h!.twin.current, first.subscription.subscriptionId, 'cancelled'));
    const second = completeDodoCheckout(h!.twin.current, await checkout(s.token));
    await deliver(second.deliveries[0]!);
    expect(await planOf(s.org)).toBe('team');
    // A retried delivery about the first, cancelled subscription, arriving late. Without
    // metadata it names no workspace at all; with it, the workspace's newer
    // subscription wins.
    const unplaced = await deliver(dodoDelivery(h!.twin.current, 'subscription.cancelled', { subscription_id: first.subscription.subscriptionId, metadata: {} }));
    expect(unplaced.json()).toMatchObject({ matched: false });
    const placed = await deliver(dodoDelivery(h!.twin.current, 'subscription.cancelled', { subscription_id: first.subscription.subscriptionId, metadata: { workspace_id: s.org } }));
    expect(placed.json()).toMatchObject({ matched: true, applied: false });
    expect(await planOf(s.org)).toBe('team');
  });

  it('never upgrades from a return URL alone: someone else’s subscription id is left to its own workspace', async () => {
    await withBilling();
    const buyer = await h!.signIn('octo', '1001');
    const other = await h!.signIn('mallory', '1666');
    const paid = completeDodoCheckout(h!.twin.current, await checkout(buyer.token), { copyMetadata: true });

    const res = await h!.call('POST', '/api/billing/refresh', other.token, { subscriptionId: paid.subscription.subscriptionId });
    expect(res.json()).toMatchObject({ pending: true });
    expect(await planOf(other.org)).toBe('free');

    const own = await h!.call('POST', '/api/billing/refresh', buyer.token, { subscriptionId: paid.subscription.subscriptionId });
    expect(own.json()).toMatchObject({ pending: false, applied: true });
    expect(await planOf(buyer.org)).toBe('team');
  });

  it('refuses a second checkout while subscribed', async () => {
    await withBilling();
    const s = await h!.signIn('octo', '1001');
    await deliver(completeDodoCheckout(h!.twin.current, await checkout(s.token)).deliveries[0]!);
    expect((await h!.call('POST', '/api/billing/checkout', s.token, { planId: 'team' })).statusCode).toBe(409);
  });

  it('says plainly when paid plans are not enabled', async () => {
    h = await harness();
    const s = await h.signIn('octo', '1001');
    expect((await h.call('POST', '/api/billing/checkout', s.token, { planId: 'team' })).statusCode).toBe(503);
    expect(((await h.app.inject({ method: 'GET', url: '/public/plans' })).json() as { enabled: boolean }).enabled).toBe(false);
    expect((await h.app.inject({ method: 'POST', url: '/webhooks/dodo', payload: '{}', headers: { 'content-type': 'application/json' } })).statusCode).toBe(404);
  });
});
