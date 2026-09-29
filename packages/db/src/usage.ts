import { and, eq, gte, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { organizations, usageEvents } from './schema.js';

export type UsageEventRow = typeof usageEvents.$inferSelect;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/** The first instant of the calendar month (UTC) containing `now`. */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Model usage per workspace. Spend is summed over calls whose cost is known;
 * `unpricedCalls` says how many were not, so a total is never presented as complete
 * when it is not.
 */
export class UsageRepository {
  constructor(private readonly db: Database) {}

  async record(input: typeof usageEvents.$inferInsert): Promise<void> {
    await this.db.insert(usageEvents).values(input);
  }

  async monthToDate(organizationId: string, now = new Date()): Promise<{ usd: number; unpricedCalls: number; calls: number }> {
    const [row] = rowsOf<{ usd: number | null; unpriced: number; calls: number }>(
      await this.db.execute(sql`
        select coalesce(sum(usd_cost), 0)::float8 as usd,
               count(*) filter (where usd_cost is null)::int as unpriced,
               count(*)::int as calls
        from usage_events
        where organization_id = ${organizationId} and at >= ${monthStart(now).toISOString()}::timestamptz`),
    );
    return { usd: row?.usd ?? 0, unpricedCalls: row?.unpriced ?? 0, calls: row?.calls ?? 0 };
  }

  async byKind(organizationId: string, now = new Date()) {
    return rowsOf<{ kind: string; model: string; calls: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; usd: number }>(
      await this.db.execute(sql`
        select kind, model, count(*)::int as calls,
               coalesce(sum(input_tokens), 0)::int as input_tokens, coalesce(sum(output_tokens), 0)::int as output_tokens,
               coalesce(sum(cache_read_tokens), 0)::int as cache_read_tokens, coalesce(sum(usd_cost), 0)::float8 as usd
        from usage_events
        where organization_id = ${organizationId} and at >= ${monthStart(now).toISOString()}::timestamptz
        group by kind, model order by kind, model`),
    );
  }

  async setBudget(organizationId: string, monthlyBudgetUsd: number | null): Promise<void> {
    await this.db.update(organizations).set({ monthlyBudgetUsd }).where(eq(organizations.id, organizationId));
  }

  async budget(organizationId: string): Promise<number | null> {
    const [org] = await this.db.select({ b: organizations.monthlyBudgetUsd }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
    return org?.b ?? null;
  }

  async since(organizationId: string, from: Date): Promise<UsageEventRow[]> {
    return this.db.select().from(usageEvents).where(and(eq(usageEvents.organizationId, organizationId), gte(usageEvents.at, from)));
  }
}
