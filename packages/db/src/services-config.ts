import { and, asc, eq } from 'drizzle-orm';
import type { ServiceConfig } from '@pager/core';
import type { Database } from './client.js';
import { integrations, repositories, services } from './schema.js';

export type ServiceRow = typeof services.$inferSelect;
export type IntegrationRow = typeof integrations.$inferSelect;

export type IntegrationProvider = 'datadog' | 'notion' | 'resend' | 'anthropic';

/**
 * Per-workspace integration settings (never secrets — those are in the vault) and
 * whether "Test connection" last passed.
 */
export class IntegrationRepository {
  constructor(private readonly db: Database) {}

  async upsert(organizationId: string, provider: IntegrationProvider, input: { baseUrl?: string | null; config?: Record<string, unknown> }): Promise<IntegrationRow> {
    const values = {
      organizationId,
      provider,
      backend: 'real',
      baseUrl: input.baseUrl ?? null,
      config: input.config ?? {},
      // A changed setting has not been tested yet.
      verifiedAt: null,
      lastError: null,
    };
    const [row] = await this.db
      .insert(integrations)
      .values(values)
      .onConflictDoUpdate({ target: [integrations.organizationId, integrations.provider], set: values })
      .returning();
    return row!;
  }

  async get(organizationId: string, provider: IntegrationProvider): Promise<IntegrationRow | null> {
    const [row] = await this.db
      .select()
      .from(integrations)
      .where(and(eq(integrations.organizationId, organizationId), eq(integrations.provider, provider)))
      .limit(1);
    return row ?? null;
  }

  async list(organizationId: string): Promise<IntegrationRow[]> {
    return this.db.select().from(integrations).where(eq(integrations.organizationId, organizationId));
  }

  async recordTest(organizationId: string, provider: IntegrationProvider, result: { ok: boolean; error?: string }): Promise<void> {
    await this.db
      .update(integrations)
      .set(result.ok ? { verifiedAt: new Date(), lastError: null } : { lastError: result.error ?? 'failed' })
      .where(and(eq(integrations.organizationId, organizationId), eq(integrations.provider, provider)));
  }
}

/**
 * Watched services and their configuration.
 *
 * Reads for the console take the workspace. `enabled` is the worker's view across
 * workspaces: every service it should be polling.
 */
export class ServiceConfigRepository {
  constructor(private readonly db: Database) {}

  async create(organizationId: string, config: ServiceConfig): Promise<ServiceRow> {
    const [row] = await this.db
      .insert(services)
      .values({ organizationId, ...toColumns(config), enabled: true })
      .returning();
    return row!;
  }

  async update(organizationId: string, id: string, config: ServiceConfig): Promise<ServiceRow | null> {
    const [row] = await this.db
      .update(services)
      // A changed health URL has not been tested.
      .set({ ...toColumns(config), healthVerifiedAt: null, healthLastError: null })
      .where(and(eq(services.id, id), eq(services.organizationId, organizationId)))
      .returning();
    return row ?? null;
  }

  async get(organizationId: string, id: string): Promise<ServiceRow | null> {
    const [row] = await this.db
      .select()
      .from(services)
      .where(and(eq(services.id, id), eq(services.organizationId, organizationId)))
      .limit(1);
    return row ?? null;
  }

  async list(organizationId: string): Promise<ServiceRow[]> {
    return this.db.select().from(services).where(eq(services.organizationId, organizationId)).orderBy(asc(services.createdAt));
  }

  async setEnabled(organizationId: string, id: string, enabled: boolean): Promise<boolean> {
    const rows = await this.db
      .update(services)
      .set({ enabled })
      .where(and(eq(services.id, id), eq(services.organizationId, organizationId)))
      .returning();
    return rows.length > 0;
  }

  async recordHealthTest(organizationId: string, id: string, result: { ok: boolean; error?: string }): Promise<void> {
    await this.db
      .update(services)
      .set(result.ok ? { healthVerifiedAt: new Date(), healthLastError: null } : { healthLastError: result.error ?? 'failed' })
      .where(and(eq(services.id, id), eq(services.organizationId, organizationId)));
  }

  /** Every service the worker should poll, with its repository. Across workspaces, by design. */
  async enabledWithRepository(): Promise<{ service: ServiceRow; repository: typeof repositories.$inferSelect }[]> {
    const rows = await this.db
      .select()
      .from(services)
      .innerJoin(repositories, eq(services.repositoryId, repositories.id))
      .where(eq(services.enabled, true));
    return rows.filter((r) => r.repositories.detachedAt === null).map((r) => ({ service: r.services, repository: r.repositories }));
  }

  async recordPoll(serviceId: string, outcome: string, at = new Date()): Promise<void> {
    await this.db.update(services).set({ lastPolledAt: at, lastPollOutcome: outcome.slice(0, 2000) }).where(eq(services.id, serviceId));
  }
}

function toColumns(c: ServiceConfig) {
  return {
    name: c.name,
    repositoryId: c.repositoryId,
    healthUrl: c.healthUrl,
    alertSource: c.alertSource,
    slackChannelId: c.slackChannelId,
    slackChannelName: c.slackChannelName ?? null,
    baseBranch: c.baseBranch ?? null,
    autonomyLevel: c.autonomyLevel,
    readOnly: c.readOnly,
    intervalSeconds: c.intervalSeconds,
    notionParentPageId: c.notionParentPageId ?? null,
    emailRecipients: c.emailRecipients,
  };
}
