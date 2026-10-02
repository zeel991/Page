import { createHmac, randomBytes } from 'node:crypto';
import type { Route, RouteContext, RouteResult } from './router.js';
import type { TwinDodoSubscription, TwinState } from './store.js';

/**
 * A Dodo Payments twin: the checkout, subscription, product and customer-portal
 * endpoints a subscription integration uses, and the webhooks Dodo would send.
 *
 * Faithful where a client depends on it: bearer auth, `{ code, message }` errors,
 * a checkout response with a URL and a session id but no subscription id, the
 * return URL gaining `subscription_id` and `status`, and Standard Webhooks
 * signatures. Paying is not an HTTP call a client makes, so it is a function:
 * `completeDodoCheckout` plays the customer finishing checkout and returns the signed
 * deliveries Dodo would then send.
 *
 * For a person trying the console locally, the twin also hosts what Dodo hosts: a
 * checkout page whose Pay button completes the checkout, delivers the webhooks to
 * `state.dodo.webhookUrl` and returns to the merchant's return URL, and a customer
 * portal page that can cancel.
 */

const UNAUTHORIZED: RouteResult = { status: 401, body: { code: 'UNAUTHORIZED', message: 'Invalid API key' } };
const notFound = (what: string): RouteResult => ({ status: 404, body: { code: 'NOT_FOUND', message: `${what} not found` } });

function guard(ctx: RouteContext): RouteResult | null {
  const key = /^Bearer\s+(.+)$/i.exec(ctx.headers.authorization ?? '')?.[1];
  return key && ctx.state.dodo.apiKeys.has(key) ? null : UNAUTHORIZED;
}

function subscriptionBody(s: TwinDodoSubscription) {
  return {
    subscription_id: s.subscriptionId,
    status: s.status,
    product_id: s.productId,
    quantity: 1,
    customer: { customer_id: s.customerId, email: s.email, name: s.email.split('@')[0] },
    metadata: s.metadata,
    next_billing_date: s.nextBillingDate,
    previous_billing_date: s.createdAt,
    cancel_at_next_billing_date: s.cancelAtNextBillingDate,
    created_at: s.createdAt,
  };
}

export function dodoRoutes(): Route[] {
  return [
    {
      method: 'POST',
      pattern: /^\/checkouts$/,
      handler: (ctx) => {
        const denied = guard(ctx);
        if (denied) return denied;
        const body = (ctx.json ?? {}) as { product_cart?: { product_id?: string }[]; customer?: { email?: string }; return_url?: string; metadata?: Record<string, string> };
        const productId = body.product_cart?.[0]?.product_id;
        if (!productId || !ctx.state.dodo.products.has(productId)) {
          return { status: 422, body: { code: 'INVALID_REQUEST', message: 'product_cart must name an existing product' } };
        }
        const sessionId = `cks_${randomBytes(8).toString('hex')}`;
        ctx.state.dodo.checkouts.set(sessionId, {
          sessionId,
          productId,
          email: body.customer?.email ?? null,
          returnUrl: body.return_url ?? null,
          metadata: body.metadata ?? {},
        });
        // Hosted by the twin itself when it knows its own address.
        const hosted = ctx.headers.host ? `http://${ctx.headers.host}/dodo/checkout/${sessionId}` : `https://test.checkout.dodopayments.com/session/${sessionId}`;
        return { status: 200, body: { session_id: sessionId, checkout_url: hosted } };
      },
    },
    {
      method: 'GET',
      pattern: /^\/subscriptions\/([^/]+)$/,
      handler: (ctx) => {
        const denied = guard(ctx);
        if (denied) return denied;
        const s = ctx.state.dodo.subscriptions.get(decodeURIComponent(ctx.params[0]!));
        return s ? { status: 200, body: subscriptionBody(s) } : notFound('Subscription');
      },
    },
    {
      method: 'GET',
      pattern: /^\/products\/([^/]+)$/,
      handler: (ctx) => {
        const denied = guard(ctx);
        if (denied) return denied;
        const p = ctx.state.dodo.products.get(decodeURIComponent(ctx.params[0]!));
        return p
          ? {
              status: 200,
              body: {
                product_id: p.productId,
                name: p.name,
                is_recurring: true,
                price: { type: 'recurring_price', price: p.priceCents, currency: p.currency, payment_frequency_interval: 'Month', payment_frequency_count: 1, subscription_period_interval: 'Year', subscription_period_count: 10 },
              },
            }
          : notFound('Product');
      },
    },
    {
      method: 'POST',
      pattern: /^\/customers\/([^/]+)\/customer-portal\/session$/,
      handler: (ctx) => {
        const denied = guard(ctx);
        if (denied) return denied;
        const customerId = decodeURIComponent(ctx.params[0]!);
        const known = [...ctx.state.dodo.subscriptions.values()].some((s) => s.customerId === customerId);
        if (!known) return notFound('Customer');
        const base = ctx.headers.host ? `http://${ctx.headers.host}/dodo` : 'https://test.customer.dodopayments.com';
        return { status: 200, body: { link: `${base}/portal/${customerId}?return_url=${encodeURIComponent(ctx.query.return_url ?? '')}` } };
      },
    },
    {
      method: 'GET',
      pattern: /^\/checkout\/([^/]+)$/,
      handler: (ctx) => {
        const checkout = ctx.state.dodo.checkouts.get(decodeURIComponent(ctx.params[0]!));
        if (!checkout) return html(404, '<p>This checkout has expired.</p>');
        const product = ctx.state.dodo.products.get(checkout.productId)!;
        return html(
          200,
          `<h1>Dodo Payments (twin) — test checkout</h1>
           <p>${escape(product.name)}: ${(product.priceCents / 100).toFixed(2)} ${escape(product.currency)} / month</p>
           <form method="post" action="/dodo/checkout/${escape(checkout.sessionId)}/pay">
             <label>Email <input name="email" value="${escape(checkout.email ?? 'buyer@example.com')}"></label>
             <button type="submit">Pay (test card)</button>
           </form>`,
        );
      },
    },
    {
      method: 'POST',
      pattern: /^\/checkout\/([^/]+)\/pay$/,
      handler: async (ctx) => {
        const sessionId = decodeURIComponent(ctx.params[0]!);
        if (!ctx.state.dodo.checkouts.has(sessionId)) return html(404, '<p>This checkout has expired.</p>');
        const done = completeDodoCheckout(ctx.state, sessionId, { email: ctx.form.get('email') || undefined });
        await deliverAll(ctx.state, done.deliveries);
        return done.returnUrl ? { status: 303, body: '', headers: { location: done.returnUrl } } : html(200, '<p>Paid.</p>');
      },
    },
    {
      method: 'GET',
      pattern: /^\/portal\/([^/]+)$/,
      handler: (ctx) => {
        const customerId = decodeURIComponent(ctx.params[0]!);
        const subs = [...ctx.state.dodo.subscriptions.values()].filter((s) => s.customerId === customerId);
        const rows = subs
          .map((s) => `<li>${escape(s.subscriptionId)}: ${escape(s.status)}${s.status === 'active' ? ` <form method="post" action="/dodo/portal/${escape(customerId)}/cancel/${escape(s.subscriptionId)}?return_url=${encodeURIComponent(ctx.query.return_url ?? '')}" style="display:inline"><button>Cancel now</button></form>` : ''}</li>`)
          .join('');
        return html(200, `<h1>Dodo Payments (twin) — customer portal</h1><ul>${rows}</ul><p><a href="${escape(ctx.query.return_url ?? '/')}">Back</a></p>`);
      },
    },
    {
      method: 'POST',
      pattern: /^\/portal\/([^/]+)\/cancel\/([^/]+)$/,
      handler: async (ctx) => {
        const id = decodeURIComponent(ctx.params[1]!);
        if (!ctx.state.dodo.subscriptions.has(id)) return html(404, '<p>No such subscription.</p>');
        await deliverAll(ctx.state, [setDodoSubscriptionStatus(ctx.state, id, 'cancelled')]);
        return { status: 303, body: '', headers: { location: ctx.query.return_url || '/' } };
      },
    },
  ];
}

function html(status: number, body: string): RouteResult {
  return { status, body: `<!doctype html><meta charset="utf-8"><title>Dodo Payments twin</title><body style="font:15px system-ui;margin:3rem">${body}</body>`, headers: { 'content-type': 'text/html; charset=utf-8' } };
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Send deliveries to the configured webhook endpoint, as Dodo would, in order. */
async function deliverAll(state: TwinState, deliveries: DodoDelivery[]): Promise<void> {
  if (!state.dodo.webhookUrl) return;
  for (const d of deliveries) {
    await fetch(state.dodo.webhookUrl, { method: 'POST', headers: d.headers, body: d.body }).catch(() => undefined);
  }
}

export interface DodoDelivery {
  headers: Record<string, string>;
  body: string;
}

function sign(secret: string, id: string, ts: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`, 'utf8').digest('base64')}`;
}

/** A signed delivery of one event, as Dodo would send it. */
export function dodoDelivery(state: TwinState, type: string, data: Record<string, unknown>, now = Date.now()): DodoDelivery {
  const id = `msg_${randomBytes(8).toString('hex')}`;
  const ts = Math.floor(now / 1000);
  const body = JSON.stringify({ business_id: state.dodo.businessId, type, timestamp: new Date(now).toISOString(), data });
  return { headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': sign(state.dodo.webhookSecret, id, ts, body) }, body };
}

/**
 * The customer completes a checkout: a customer and an active subscription exist,
 * and Dodo sends `payment.succeeded` and `subscription.active`. The checkout's
 * metadata is copied onto the subscription only when `copyMetadata` is set, since
 * Dodo's documentation does not promise it and the integration must not depend on it.
 */
export function completeDodoCheckout(
  state: TwinState,
  sessionId: string,
  opts: { email?: string; copyMetadata?: boolean; now?: number } = {},
): { subscription: TwinDodoSubscription; returnUrl: string | null; deliveries: DodoDelivery[] } {
  const checkout = state.dodo.checkouts.get(sessionId);
  if (!checkout) throw new Error(`no checkout session ${sessionId}`);
  const now = opts.now ?? Date.now();
  const email = opts.email ?? checkout.email ?? 'buyer@example.com';
  const subscription: TwinDodoSubscription = {
    subscriptionId: `sub_${randomBytes(8).toString('hex')}`,
    customerId: `cus_${randomBytes(8).toString('hex')}`,
    email,
    productId: checkout.productId,
    status: 'active',
    metadata: opts.copyMetadata ? { ...checkout.metadata } : {},
    createdAt: new Date(now).toISOString(),
    nextBillingDate: new Date(now + 30 * 86_400_000).toISOString(),
    cancelAtNextBillingDate: false,
  };
  state.dodo.subscriptions.set(subscription.subscriptionId, subscription);
  const returnUrl = checkout.returnUrl
    ? `${checkout.returnUrl}${checkout.returnUrl.includes('?') ? '&' : '?'}subscription_id=${subscription.subscriptionId}&status=active&email=${encodeURIComponent(email)}`
    : null;
  const deliveries = [
    dodoDelivery(state, 'payment.succeeded', { payment_id: `pay_${randomBytes(6).toString('hex')}`, checkout_session_id: sessionId, subscription_id: subscription.subscriptionId, metadata: checkout.metadata, status: 'succeeded' }, now),
    dodoDelivery(state, 'subscription.active', subscriptionBody(subscription), now),
  ];
  return { subscription, returnUrl, deliveries };
}

/** The subscription changes status (a failed renewal, a cancellation), and Dodo says so. */
export function setDodoSubscriptionStatus(state: TwinState, subscriptionId: string, status: string, type = `subscription.${status}`, now = Date.now()): DodoDelivery {
  const s = state.dodo.subscriptions.get(subscriptionId);
  if (!s) throw new Error(`no subscription ${subscriptionId}`);
  s.status = status;
  return dodoDelivery(state, type, subscriptionBody(s), now);
}
