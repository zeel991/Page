import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from './client.js';
import { memberships, slackInstallations, users } from './schema.js';

export type SlackInstallationRow = typeof slackInstallations.$inferSelect;

export class SlackTeamClaimedError extends Error {
  constructor(teamId: string) {
    super(`Slack team ${teamId} is already connected to another workspace.`);
    this.name = 'SlackTeamClaimedError';
  }
}

/** Roles whose members may merge from Slack, once their Slack identity is linked. */
export const MERGE_ROLES = ['owner', 'admin'] as const;

/**
 * Slack teams and the people in them.
 *
 * A merge click names a Slack team and a Slack user. The team routes it to exactly
 * one workspace; the user counts only if they are that workspace's owner or admin
 * with that Slack id linked to their membership. Nothing is configured by name.
 */
export class SlackRepository {
  constructor(private readonly db: Database) {}

  async bind(input: { organizationId: string; teamId: string; teamName: string; botUserId: string | null; installedByUserId: string }): Promise<SlackInstallationRow> {
    const [existing] = await this.db.select().from(slackInstallations).where(eq(slackInstallations.teamId, input.teamId)).limit(1);
    if (existing && existing.organizationId !== input.organizationId && !existing.removedAt) throw new SlackTeamClaimedError(input.teamId);
    if (existing) {
      const [row] = await this.db
        .update(slackInstallations)
        .set({ ...input, removedAt: null })
        .where(eq(slackInstallations.id, existing.id))
        .returning();
      return row!;
    }
    const [row] = await this.db.insert(slackInstallations).values(input).returning();
    return row!;
  }

  async forOrganization(organizationId: string): Promise<SlackInstallationRow | null> {
    const [row] = await this.db
      .select()
      .from(slackInstallations)
      .where(and(eq(slackInstallations.organizationId, organizationId), isNull(slackInstallations.removedAt)))
      .limit(1);
    return row ?? null;
  }

  /** The workspace a click from this Slack team belongs to. */
  async byTeamId(teamId: string): Promise<SlackInstallationRow | null> {
    const [row] = await this.db
      .select()
      .from(slackInstallations)
      .where(and(eq(slackInstallations.teamId, teamId), isNull(slackInstallations.removedAt)))
      .limit(1);
    return row ?? null;
  }

  /** The owner or admin of this workspace whose linked Slack id is `slackUserId`, or null. */
  async approver(organizationId: string, slackUserId: string): Promise<{ userId: string; role: string; name: string } | null> {
    const [row] = await this.db
      .select({ userId: memberships.userId, role: memberships.role, name: users.name, login: users.login })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.slackUserId, slackUserId),
          inArray(memberships.role, [...MERGE_ROLES]),
        ),
      )
      .limit(1);
    return row ? { userId: row.userId, role: row.role, name: row.login ?? row.name } : null;
  }

  async linkMember(organizationId: string, membershipId: string, slackUserId: string | null): Promise<boolean> {
    const rows = await this.db
      .update(memberships)
      .set({ slackUserId })
      .where(and(eq(memberships.id, membershipId), eq(memberships.organizationId, organizationId)))
      .returning();
    return rows.length > 0;
  }
}
