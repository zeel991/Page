import { createHmac, timingSafeEqual } from 'node:crypto';
import { Http, ProviderHttpError } from '../http.js';

/**
 * Dodo Payments: how a workspace buys a paid plan.
 *
 * Written against the REST API (docs.dodopayments.com, OpenAPI v1.116), not the SDK:
 *
 *  - Two hosts, one per mode, and a key works only in the mode it was made in. The
 *    SDK defaults to live mode; this defaults to test mode, so a missing setting
 *    never takes real money.
 *  - A hosted checkout is `POST /checkouts` (the older `POST /subscriptions` with
 *    `payment_link` is deprecated). Its response carries no subscription id: that
 *    arrives on the return URL and in webhooks.
 *  - Nothing is inferred from a webhook's payload beyond which subscription it is
 *    about. The subscription is then read back (`GET /subscriptions/{id}`), because
 *    deliveries can arrive out of order and a read is the current state.
 *  - Webhooks follow Standard Webhooks: HMAC-SHA256 over `{id}.{timestamp}.{body}`
 *    with the base64 key after `whsec_`, in `webhook-signature` as `v1,<sig>` entries.
 *  - Errors are `{ code, message }`; `code` is what to branch on.
 */

export const DODO_BASE_URLS = {
  test_mode: 'https://test.dodopayments.com',
  live_mode: 'https://live.dodopayments.com',
} as const;
export type DodoMode = keyof typeof DODO_BASE_URLS;

export interface DodoSubscription {
  subscriptionId: string;
  status: string;
  productId: string;
  customerId: string | null;
  customerEmail: string | null;
  nextBillingAt: Date | null;
  cancelAtPeriodEnd: boolean;
  metadata: Record<string, string | number | boolean>;
}

export interface DodoPrice {
  /** In the currency's minor unit (cents). */
  amount: number;
  currency: string;
  /** e.g. "Month", with `intervalCount` of them per charge. */
  interval: string | null;
  intervalCount: number | null;
  recurring: boolean;
}

export interface DodoProduct {
  productId: string;
  name: string | null;
  price: DodoPrice | null;
}

interface RawSubscription {
  subscription_id: string;
  status: string;
  product_id: string;
  customer?: { customer_id?: string; email?: string } | null;
  next_billing_date?: string | null;
  cancel_at_next_billing_date?: boolean;
  metadata?: Record<string, string | number | boolean> | null;
}

interface RawProduct {
  product_id: string;
  name?: string | null;
  price?: {
    type?: string;
    price?: number;
    fixed_price?: number;
    currency?: string;
    payment_frequency_interval?: string;
    payment_frequency_count?: number;
  } | null;
}

export class DodoApiError extends Error {
  constructor(
    readonly status: number,
    /** Dodo's machine-readable code, e.g. MERCHANT_NOT_LIVE; null when the body had none. */
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'DodoApiError';
  }
}

export class DodoPaymentsClient {
  private readonly http: Http;

  constructor(opts: { baseUrl: string; apiKey: string; fetchImpl?: typeof globalThis.fetch }) {
    this.http = new Http({
      baseUrl: opts.baseUrl,
      headers: { authorization: `Bearer ${opts.apiKey}` },
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }

  /** A hosted checkout for one subscription product. */
  async createCheckout(input: {
    productId: string;
    customer?: { email: string; name?: string | null };
    returnUrl: string;
    metadata: Record<string, string>;
  }): Promise<{ sessionId: string; checkoutUrl: string }> {
    const body = {
      product_cart: [{ product_id: input.productId, quantity: 1 }],
      ...(input.customer ? { customer: { email: input.customer.email, ...(input.customer.name ? { name: input.customer.name } : {}) } } : {}),
      return_url: input.returnUrl,
      metadata: input.metadata,
    };
    const res = await this.call(() => this.http.post<{ session_id?: string; checkout_url?: string | null }>('/checkouts', body));
    if (!res.session_id || !res.checkout_url) throw new DodoApiError(200, null, 'Dodo created a checkout session but returned no checkout URL');
    return { sessionId: res.session_id, checkoutUrl: res.checkout_url };
  }

  async getSubscription(subscriptionId: string): Promise<DodoSubscription> {
    const raw = await this.call(() => this.http.get<RawSubscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}`));
    return {
      subscriptionId: raw.subscription_id,
      status: raw.status,
      productId: raw.product_id,
      customerId: raw.customer?.customer_id ?? null,
      customerEmail: raw.customer?.email ?? null,
      nextBillingAt: raw.next_billing_date ? new Date(raw.next_billing_date) : null,
      cancelAtPeriodEnd: raw.cancel_at_next_billing_date === true,
      metadata: raw.metadata ?? {},
    };
  }

  async getProduct(productId: string): Promise<DodoProduct> {
    const raw = await this.call(() => this.http.get<RawProduct>(`/products/${encodeURIComponent(productId)}`));
    const p = raw.price;
    const amount = p?.price ?? p?.fixed_price;
    return {
      productId: raw.product_id,
      name: raw.name ?? null,
      price:
        p && typeof amount === 'number' && p.currency
          ? {
              amount,
              currency: p.currency,
              interval: p.payment_frequency_interval ?? null,
              intervalCount: p.payment_frequency_count ?? null,
              recurring: p.type === 'recurring_price',
            }
          : null,
    };
  }

  /** A link into Dodo's customer portal, where a customer updates payment details or cancels. */
  async customerPortal(customerId: string, returnUrl: string): Promise<string> {
    const path = `/customers/${encodeURIComponent(customerId)}/customer-portal/session?return_url=${encodeURIComponent(returnUrl)}`;
    const res = await this.call(() => this.http.post<{ link?: string }>(path));
    if (!res.link) throw new DodoApiError(200, null, 'Dodo returned no customer portal link');
    return res.link;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProviderHttpError) {
        let code: string | null = null;
        let message = err.message;
        try {
          const body = JSON.parse(err.body) as { code?: unknown; message?: unknown };
          if (typeof body.code === 'string') code = body.code;
          if (typeof body.message === 'string') message = `Dodo Payments refused (${err.status}${code ? ` ${code}` : ''}): ${body.message}`;
        } catch {
          // Not JSON; keep the transport message.
        }
        throw new DodoApiError(err.status, code, message);
      }
      throw err;
    }
  }
}

// ── Webhooks ─────────────────────────────────────────────────────────────────

export interface DodoWebhookEvent {
  /** `webhook-id`: the delivery's id, stable across retries. */
  deliveryId: string;
  type: string;
  businessId: string | null;
  data: {
    subscriptionId: string | null;
    checkoutSessionId: string | null;
    metadata: Record<string, unknown>;
  };
}

export class DodoWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DodoWebhookError';
  }
}

const TOLERANCE_SECONDS = 5 * 60;

/** The Standard Webhooks key: the base64 after `whsec_`. */
function webhookKey(secret: string): Buffer {
  return Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');
}

/** Sign a delivery as Dodo does. Exported for the twin and tests. */
export function signDodoWebhook(secret: string, deliveryId: string, timestampSeconds: number, body: string): string {
  const sig = createHmac('sha256', webhookKey(secret)).update(`${deliveryId}.${timestampSeconds}.${body}`, 'utf8').digest('base64');
  return `v1,${sig}`;
}

/**
 * Verify a delivery and read the little this system uses from it.
 *
 * Throws `DodoWebhookError` for a missing header, a timestamp outside five minutes,
 * or no matching signature; any one is reason to refuse the delivery.
 */
export function verifyDodoWebhook(secret: string, headers: Record<string, string | string[] | undefined>, rawBody: string, now = Date.now()): DodoWebhookEvent {
  const header = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const id = header('webhook-id');
  const timestamp = header('webhook-timestamp');
  const signatures = header('webhook-signature');
  if (!id || !timestamp || !signatures) throw new DodoWebhookError('missing webhook-id, webhook-timestamp or webhook-signature');
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(now / 1000 - ts) > TOLERANCE_SECONDS) throw new DodoWebhookError('timestamp outside the five-minute tolerance');

  const expected = Buffer.from(signDodoWebhook(secret, id, ts, rawBody).slice(3));
  const matched = signatures.split(' ').some((entry) => {
    const [version, sig] = entry.split(',', 2);
    if (version !== 'v1' || !sig) return false;
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matched) throw new DodoWebhookError('no signature matches');

  let payload: { type?: unknown; business_id?: unknown; data?: Record<string, unknown> };
  try {
    payload = JSON.parse(rawBody) as typeof payload;
  } catch {
    throw new DodoWebhookError('signed body is not JSON');
  }
  const data = payload.data ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    deliveryId: id,
    type: str(payload.type) ?? 'unknown',
    businessId: str(payload.business_id),
    data: {
      subscriptionId: str(data.subscription_id),
      checkoutSessionId: str(data.checkout_session_id),
      metadata: data.metadata && typeof data.metadata === 'object' ? (data.metadata as Record<string, unknown>) : {},
    },
  };
}

// ── Configuration ────────────────────────────────────────────────────────────

export interface DodoBillingConfig {
  client: DodoPaymentsClient;
  mode: DodoMode;
  webhookSecret: string;
  /** Plan id → Dodo product id, from DODO_PRODUCT_<PLAN>. */
  products: Record<string, string>;
}

/**
 * Billing from the operator's environment, or null when it is not configured, in
 * which case paid plans are shown as unavailable rather than pretended.
 */
export function dodoFromEnv(env: NodeJS.ProcessEnv): DodoBillingConfig | null {
  const apiKey = env.DODO_PAYMENTS_API_KEY?.trim();
  const webhookSecret = env.DODO_PAYMENTS_WEBHOOK_SECRET?.trim();
  if (!apiKey || !webhookSecret) return null;
  const rawMode = env.DODO_PAYMENTS_ENVIRONMENT?.trim() || 'test_mode';
  if (rawMode !== 'test_mode' && rawMode !== 'live_mode') throw new Error(`DODO_PAYMENTS_ENVIRONMENT must be test_mode or live_mode (got "${rawMode}")`);
  const mode = rawMode as DodoMode;
  const products: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const m = /^DODO_PRODUCT_([A-Z0-9_]+)$/.exec(key);
    if (m && value?.trim()) products[m[1]!.toLowerCase()] = value.trim();
  }
  // PAGER_DODO_URL points at the local twin in development and tests.
  const baseUrl = env.PAGER_DODO_URL?.trim() || DODO_BASE_URLS[mode];
  return { client: new DodoPaymentsClient({ baseUrl, apiKey }), mode, webhookSecret, products };
}
