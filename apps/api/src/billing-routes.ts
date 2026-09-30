import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BillingRepository, ENTITLING_STATUSES, IdentityRepository, PlanRepository, type Database } from '@pager/db';
import { DodoApiError, DodoWebhookError, verifyDodoWebhook, type DodoBillingConfig, type DodoPrice } from '@pager/providers';
import { auth, requireRole } from './auth.ts';

/**
 * Paid plans, bought through Dodo Payments.
 *
 * The workspace's plan is only ever set from Dodo's own reading of a subscription:
 * a signed webhook names a subscription, and the subscription is then read back
 * (`GET /subscriptions/{id}`) and applied. Nothing a browser sends — the return URL's
 * `status=active`, a form field — sets a plan by itself.
 *
 * Which workspace a subscription belongs to is known three ways, in order: a
 * subscription already recorded for it; the checkout session this API opened,
 * named by the payment; the `workspace_id` this API put in the checkout's metadata,
 * when Dodo has copied it onto the subscription (its documentation implies but does
 * not promise that).
 */

export interface BillingDeps {
  db: Database;
  billing: DodoBillingConfig | null;
  webOrigin: string;
  now?: () => number;
}

export interface PlanOffer {
  id: string;
  name: string;
  maxServices: number;
  maxIncidentsPerMonth: number;
  includedModelUsd: number | null;
  /** Null for the free plan, and when the price could not be read: unknown, not free. */
  price: DodoPrice | null;
  purchasable: boolean;
}

const PRICE_TTL_MS = 10 * 60_000;

function planForProduct(billing: DodoBillingConfig, productId: string): string | null {
  return Object.entries(billing.products).find(([, p]) => p === productId)?.[0] ?? null;
}

export class BillingService {
  readonly repo: BillingRepository;
  private readonly plans: PlanRepository;
  private readonly prices = new Map<string, { price: DodoPrice | null; at: number }>();
  private readonly now: () => number;
  private readonly deps: BillingDeps;

  constructor(deps: BillingDeps) {
    this.deps = deps;
    this.repo = new BillingRepository(deps.db);
    this.plans = new PlanRepository(deps.db);
    this.now = deps.now ?? Date.now;
  }

  get billing(): DodoBillingConfig | null {
    return this.deps.billing;
  }

  /** Every plan with its price as Dodo states it; cached, since a pricing page is public. */
  async offers(): Promise<PlanOffer[]> {
    const billing = this.deps.billing;
    return Promise.all(
      (await this.plans.all()).map(async (p) => {
        const productId = billing?.products[p.id];
        return {
          id: p.id,
          name: p.name,
          maxServices: p.maxServices,
          maxIncidentsPerMonth: p.maxIncidentsPerMonth,
          includedModelUsd: p.includedModelUsd,
          price: productId ? await this.price(productId) : null,
          purchasable: Boolean(productId),
        };
      }),
    );
  }

  private async price(productId: string): Promise<DodoPrice | null> {
    const cached = this.prices.get(productId);
    if (cached && this.now() - cached.at < PRICE_TTL_MS) return cached.price;
    let price: DodoPrice | null = null;
    try {
      price = (await this.deps.billing!.client.getProduct(productId)).price;
    } catch {
      // Unknown, shown as such; retried after the TTL.
    }
    this.prices.set(productId, { price, at: this.now() });
    return price;
  }

  /**
   * Read a subscription from Dodo and apply it to `organizationId`. Returns why not,
   * when it cannot be applied.
   */
  async sync(organizationId: string, subscriptionId: string): Promise<{ applied: boolean; planId?: string; reason?: string }> {
    const billing = this.deps.billing!;
    const sub = await billing.client.getSubscription(subscriptionId);
    const planId = planForProduct(billing, sub.productId);
    if (!planId) return { applied: false, reason: `product ${sub.productId} is not one of this deployment's plans` };
    const result = await this.repo.apply(organizationId, {
      subscriptionId: sub.subscriptionId,
      customerId: sub.customerId,
      productId: sub.productId,
      planId,
      status: sub.status,
      nextBillingAt: sub.nextBillingAt,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    });
    return result.applied ? { applied: true, planId: result.planId } : { applied: false, reason: 'an older subscription than the workspace’s current one' };
  }
}

const Checkout = z.object({ planId: z.string().min(1) });
const Refresh = z.object({ subscriptionId: z.string().min(1).max(200) });

/** Console routes, behind the session guard. */
export async function registerBillingRoutes(app: FastifyInstance, service: BillingService, deps: BillingDeps): Promise<void> {
  const identity = new IdentityRepository(deps.db);

  app.get('/api/billing', async (request) => {
    const { organizationId } = auth(request);
    const sub = await service.repo.forOrganization(organizationId);
    return {
      enabled: service.billing !== null,
      mode: service.billing?.mode ?? null,
      subscription: sub
        ? { planId: sub.planId, status: sub.status, nextBillingAt: sub.nextBillingAt, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, manageable: Boolean(sub.customerId) }
        : null,
      plans: await service.offers(),
    };
  });

  app.post('/api/billing/checkout', async (request, reply) => {
    if (!requireRole(request, reply, ['owner'])) return reply;
    const billing = service.billing;
    if (!billing) return reply.code(503).send({ error: 'billing_unavailable', reason: 'Paid plans are not enabled on this deployment.' });
    const parsed = Checkout.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: 'invalid', problems: { planId: 'choose a plan' } });
    const productId = billing.products[parsed.data.planId];
    if (!productId) return reply.code(422).send({ error: 'invalid', problems: { planId: 'that plan cannot be bought here' } });

    const { organizationId, userId } = auth(request);
    const current = await service.repo.forOrganization(organizationId);
    if (current && ENTITLING_STATUSES.has(current.status)) {
      return reply.code(409).send({ error: 'already_subscribed', reason: 'This workspace already has a paid subscription. Change or cancel it from Manage billing.' });
    }
    const user = await identity.user(userId);
    try {
      const session = await billing.client.createCheckout({
        productId,
        ...(user?.email ? { customer: { email: user.email, name: user.name } } : {}),
        returnUrl: `${deps.webOrigin}/billing/return`,
        metadata: { workspace_id: organizationId, plan_id: parsed.data.planId },
      });
      await service.repo.recordCheckout(session.sessionId, organizationId, parsed.data.planId, userId);
      return { url: session.checkoutUrl };
    } catch (err) {
      if (err instanceof DodoApiError) return reply.code(502).send({ error: 'billing_provider', reason: err.message });
      throw err;
    }
  });

  app.post('/api/billing/portal', async (request, reply) => {
    if (!requireRole(request, reply, ['owner'])) return reply;
    const billing = service.billing;
    if (!billing) return reply.code(503).send({ error: 'billing_unavailable', reason: 'Paid plans are not enabled on this deployment.' });
    const sub = await service.repo.forOrganization(auth(request).organizationId);
    if (!sub?.customerId) return reply.code(409).send({ error: 'no_subscription', reason: 'This workspace has no subscription to manage yet.' });
    try {
      return { url: await billing.client.customerPortal(sub.customerId, `${deps.webOrigin}/settings`) };
    } catch (err) {
      if (err instanceof DodoApiError) return reply.code(502).send({ error: 'billing_provider', reason: err.message });
      throw err;
    }
  });

  /**
   * After checkout Dodo returns the person with `?subscription_id=…`. The id alone
   * proves nothing, so it is applied only when Dodo's own record ties it to this
   * workspace; otherwise the webhook, already on its way, settles it.
   */
  app.post('/api/billing/refresh', async (request, reply) => {
    const billing = service.billing;
    if (!billing) return reply.code(503).send({ error: 'billing_unavailable' });
    const parsed = Refresh.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: 'invalid' });
    const { organizationId } = auth(request);
    let sub;
    try {
      sub = await billing.client.getSubscription(parsed.data.subscriptionId);
    } catch (err) {
      if (err instanceof DodoApiError && err.status === 404) return reply.code(404).send({ error: 'not_found' });
      if (err instanceof DodoApiError) return reply.code(502).send({ error: 'billing_provider', reason: err.message });
      throw err;
    }
    const owner = (await service.repo.organizationForSubscription(sub.subscriptionId)) ?? (sub.metadata.workspace_id === organizationId ? organizationId : null);
    if (owner !== organizationId) return { pending: true };
    return { pending: false, ...(await service.sync(organizationId, sub.subscriptionId)) };
  });
}

/** Public: what the plans are and cost, for the pricing page. */
export async function registerPublicBillingRoutes(app: FastifyInstance, service: BillingService): Promise<void> {
  app.get('/public/plans', async () => ({ enabled: service.billing !== null, plans: await service.offers() }));
}

/** Dodo's webhooks. In the scope whose JSON bodies arrive as the raw string. */
export async function registerDodoWebhook(app: FastifyInstance, service: BillingService, log: (line: string) => void): Promise<void> {
  app.post('/webhooks/dodo', async (request, reply) => {
    const billing = service.billing;
    if (!billing) return reply.code(404).send({ error: 'billing_unavailable' });
    const raw = typeof request.body === 'string' ? request.body : '';
    let event;
    try {
      event = verifyDodoWebhook(billing.webhookSecret, request.headers, raw);
    } catch (err) {
      return reply.code(401).send({ error: 'unverified', reason: err instanceof DodoWebhookError ? err.message : 'invalid' });
    }
    if (await service.repo.seenDelivery('dodo', event.deliveryId)) return { ok: true, duplicate: true };

    const subscriptionId = event.data.subscriptionId;
    if (!subscriptionId || !(event.type.startsWith('subscription.') || event.type.startsWith('payment.'))) {
      await service.repo.recordDelivery('dodo', event.deliveryId);
      return { ok: true, ignored: event.type };
    }
    const metadataOrg = typeof event.data.metadata.workspace_id === 'string' ? event.data.metadata.workspace_id : null;
    const organizationId =
      (await service.repo.organizationForSubscription(subscriptionId)) ??
      (event.data.checkoutSessionId ? (await service.repo.checkout(event.data.checkoutSessionId))?.organizationId : null) ??
      (metadataOrg && (await service.repo.organizationExists(metadataOrg)) ? metadataOrg : null);
    if (!organizationId) {
      // Nothing to apply yet. Checkout sends the payment (naming its session) with
      // the activation, and whichever places the subscription applies its current
      // state, so a subscription event that arrives first loses nothing.
      log(`dodo ${event.type} for ${subscriptionId}: no workspace yet`);
      return { ok: true, matched: false };
    }
    // A failed read is a 5xx, so Dodo retries the delivery.
    const result = await service.sync(organizationId, subscriptionId);
    await service.repo.recordDelivery('dodo', event.deliveryId);
    if (!result.applied) log(`dodo ${event.type} for ${subscriptionId}: not applied (${result.reason})`);
    return { ok: true, matched: true, applied: result.applied };
  });
}
