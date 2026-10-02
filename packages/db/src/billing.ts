import { and, eq } from 'drizzle-orm';
import type { Database } from './client.js';
import { billingCheckouts, billingSubscriptions, organizations, webhookDeliveries } from './schema.js';

export type BillingSubscriptionRow = typeof billingSubscriptions.$inferSelect;

/** What the payment provider says a subscription is, now. */
export interface SubscriptionState {
  subscriptionId: string;
  customerId: string | null;
  productId: string;
  /** The plan the product buys. */
  planId: string;
  status: string;
  nextBillingAt: Date | null;
  cancelAtPeriodEnd: boolean;
}

/**
 * Statuses that keep the paid plan. `past_due` is the provider's grace window after
 * a failed renewal; `on_hold`, `paused`, `cancelled`, `failed` and `expired` end it.
 * `pending` has not been paid for. Anything unknown is treated as not paid for.
 */
export const ENTITLING_STATUSES: ReadonlySet<string> = new Set(['active', 'past_due']);
export const FREE_PLAN = 'free';

export class BillingRepository {
  constructor(private readonly db: Database) {}

  async recordCheckout(sessionId: string, organizationId: string, planId: string, createdBy: string | null): Promise<void> {
    await this.db.insert(billingCheckouts).values({ sessionId, organizationId, planId, createdBy }).onConflictDoNothing();
  }

  async checkout(sessionId: string): Promise<{ organizationId: string; planId: string } | null> {
    const [row] = await this.db.select().from(billingCheckouts).where(eq(billingCheckouts.sessionId, sessionId)).limit(1);
    return row ? { organizationId: row.organizationId, planId: row.planId } : null;
  }

  async forOrganization(organizationId: string): Promise<BillingSubscriptionRow | null> {
    const [row] = await this.db.select().from(billingSubscriptions).where(eq(billingSubscriptions.organizationId, organizationId)).limit(1);
    return row ?? null;
  }

  async organizationForSubscription(subscriptionId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ org: billingSubscriptions.organizationId })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.subscriptionId, subscriptionId))
      .limit(1);
    return row?.org ?? null;
  }

  async organizationExists(organizationId: string): Promise<boolean> {
    const [row] = await this.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
    return Boolean(row);
  }

  /**
   * Record a subscription's current state for a workspace, and set the workspace's
   * plan from it.
   *
   * Idempotent, and safe out of order, because `state` is always the provider's
   * current reading rather than an event's delta. One guard: a subscription that is
   * not the workspace's own and does not entitle anything is ignored, so a late
   * event about an old, cancelled subscription cannot undo a newer one.
   */
  async apply(organizationId: string, state: SubscriptionState, now = new Date()): Promise<{ applied: boolean; planId: string }> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(billingSubscriptions).where(eq(billingSubscriptions.organizationId, organizationId)).for('update').limit(1);
      const entitles = ENTITLING_STATUSES.has(state.status);
      if (current && current.subscriptionId !== state.subscriptionId && !entitles) {
        const [org] = await tx.select({ planId: organizations.planId }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
        return { applied: false, planId: org?.planId ?? FREE_PLAN };
      }
      const values = {
        organizationId,
        provider: 'dodo',
        customerId: state.customerId,
        subscriptionId: state.subscriptionId,
        productId: state.productId,
        planId: state.planId,
        status: state.status,
        nextBillingAt: state.nextBillingAt,
        cancelAtPeriodEnd: state.cancelAtPeriodEnd,
        updatedAt: now,
      };
      await tx.insert(billingSubscriptions).values(values).onConflictDoUpdate({ target: billingSubscriptions.organizationId, set: values });
      const planId = entitles ? state.planId : FREE_PLAN;
      await tx.update(organizations).set({ planId }).where(eq(organizations.id, organizationId));
      return { applied: true, planId };
    });
  }

  async seenDelivery(provider: string, deliveryId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: webhookDeliveries.deliveryId })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.provider, provider), eq(webhookDeliveries.deliveryId, deliveryId)))
      .limit(1);
    return Boolean(row);
  }

  async recordDelivery(provider: string, deliveryId: string): Promise<void> {
    await this.db.insert(webhookDeliveries).values({ provider, deliveryId }).onConflictDoNothing();
  }
}
