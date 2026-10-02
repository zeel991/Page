import { and, eq, gte, ne, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { incidents, organizations, plans, services } from './schema.js';
import { monthStart } from './usage.js';

export type PlanRow = typeof plans.$inferSelect;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/**
 * A workspace's plan and how much of it is used. Sample services — the ones "Send a
 * test incident" creates — count toward neither limit.
 */
export class PlanRepository {
  constructor(private readonly db: Database) {}

  async forOrganization(organizationId: string): Promise<PlanRow> {
    const [row] = await this.db
      .select({ plan: plans })
      .from(organizations)
      .innerJoin(plans, eq(organizations.planId, plans.id))
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (!row) throw new Error(`workspace ${organizationId} has no plan`);
    return row.plan;
  }

  /** Every plan, cheapest limits first, for a pricing page. */
  async all(): Promise<PlanRow[]> {
    return (await this.db.select().from(plans)).sort((a, b) => a.maxServices - b.maxServices);
  }

  async servicesUsed(organizationId: string): Promise<number> {
    const [row] = rowsOf<{ n: number }>(
      await this.db.execute(sql`select count(*)::int as n from services where organization_id = ${organizationId} and alert_source <> 'sample'`),
    );
    return row?.n ?? 0;
  }

  async incidentsThisMonth(organizationId: string, now = new Date()): Promise<number> {
    const rows = await this.db
      .select({ id: incidents.id })
      .from(incidents)
      .innerJoin(services, eq(incidents.serviceId, services.id))
      .where(and(eq(incidents.organizationId, organizationId), gte(incidents.openedAt, monthStart(now)), ne(services.alertSource, 'sample')));
    return rows.length;
  }

  async usage(organizationId: string, now = new Date()) {
    const plan = await this.forOrganization(organizationId);
    return {
      plan: { id: plan.id, name: plan.name },
      services: { used: await this.servicesUsed(organizationId), limit: plan.maxServices },
      incidentsThisMonth: { used: await this.incidentsThisMonth(organizationId, now), limit: plan.maxIncidentsPerMonth },
      includedModelUsd: plan.includedModelUsd,
    };
  }
}
