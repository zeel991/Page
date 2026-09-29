import { and, eq } from 'drizzle-orm';
import { lastFour, seal, unseal, type KeyWrapper } from '@pager/core';
import type { Database } from './client.js';
import { integrationCredentials } from './schema.js';

/**
 * Stores and retrieves tenant secrets.
 *
 * `reveal` is for the worker, at the moment a provider is constructed; nothing that
 * serves a browser should call it. `describe` is what the console shows: which kinds
 * are configured, and the last four characters of each.
 */

export type CredentialKind =
  | 'datadog.api_key'
  | 'datadog.app_key'
  | 'slack.bot_token'
  | 'anthropic.api_key'
  | 'notion.token'
  | 'resend.api_key';

export interface CredentialSummary {
  kind: CredentialKind;
  last4: string;
  createdAt: Date;
  rotatedAt: Date | null;
}

const context = (organizationId: string, kind: string) => `pager:${organizationId}:${kind}`;

export class CredentialVault {
  constructor(
    private readonly db: Database,
    private readonly wrapper: KeyWrapper,
  ) {}

  async put(organizationId: string, kind: CredentialKind, secret: string, integrationId: string | null = null): Promise<CredentialSummary> {
    const value = secret.trim();
    if (!value) throw new Error(`An empty ${kind} cannot be stored.`);
    const sealed = await seal(this.wrapper, value, context(organizationId, kind));
    const last4 = lastFour(value);
    const [row] = await this.db
      .insert(integrationCredentials)
      .values({ organizationId, kind, integrationId, last4, ...sealed })
      .onConflictDoUpdate({
        target: [integrationCredentials.organizationId, integrationCredentials.kind],
        set: { ...sealed, last4, integrationId, rotatedAt: new Date() },
      })
      .returning();
    return { kind, last4: row!.last4, createdAt: row!.createdAt, rotatedAt: row!.rotatedAt };
  }

  /** The plaintext, or null when this workspace has none of this kind. */
  async reveal(organizationId: string, kind: CredentialKind): Promise<string | null> {
    const [row] = await this.db
      .select()
      .from(integrationCredentials)
      .where(and(eq(integrationCredentials.organizationId, organizationId), eq(integrationCredentials.kind, kind)))
      .limit(1);
    if (!row) return null;
    return unseal(this.wrapper, row, context(organizationId, kind));
  }

  async describe(organizationId: string): Promise<CredentialSummary[]> {
    const rows = await this.db
      .select({
        kind: integrationCredentials.kind,
        last4: integrationCredentials.last4,
        createdAt: integrationCredentials.createdAt,
        rotatedAt: integrationCredentials.rotatedAt,
      })
      .from(integrationCredentials)
      .where(eq(integrationCredentials.organizationId, organizationId));
    return rows as CredentialSummary[];
  }

  async remove(organizationId: string, kind: CredentialKind): Promise<void> {
    await this.db
      .delete(integrationCredentials)
      .where(and(eq(integrationCredentials.organizationId, organizationId), eq(integrationCredentials.kind, kind)));
  }
}
