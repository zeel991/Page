import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from './client.js';
import { githubInstallations, repositories } from './schema.js';

export type GitHubInstallationRow = typeof githubInstallations.$inferSelect;
export type RepositoryRow = typeof repositories.$inferSelect;

/** An installation id is already bound to a different workspace. */
export class InstallationClaimedError extends Error {
  constructor(installationId: number) {
    super(`GitHub installation ${installationId} is already connected to another workspace.`);
    this.name = 'InstallationClaimedError';
  }
}

/**
 * GitHub App installations and the repositories picked from them.
 *
 * Every method that reads for a workspace takes the workspace id. The webhook
 * methods take an installation id instead, because GitHub names installations, not
 * workspaces — and they only ever narrow access (suspend, remove, detach).
 */
export class InstallationRepository {
  constructor(private readonly db: Database) {}

  async bind(input: {
    organizationId: string;
    installationId: number;
    accountLogin: string;
    accountType: string;
    repositorySelection: string;
    installedByUserId: string;
  }): Promise<GitHubInstallationRow> {
    const [existing] = await this.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, input.installationId))
      .limit(1);
    if (existing && existing.organizationId !== input.organizationId) throw new InstallationClaimedError(input.installationId);
    if (existing) {
      const [row] = await this.db
        .update(githubInstallations)
        .set({ accountLogin: input.accountLogin, repositorySelection: input.repositorySelection, removedAt: null })
        .where(eq(githubInstallations.id, existing.id))
        .returning();
      return row!;
    }
    const [row] = await this.db.insert(githubInstallations).values(input).returning();
    return row!;
  }

  /** Installations this workspace can use: connected, not removed, not suspended. */
  async active(organizationId: string): Promise<GitHubInstallationRow[]> {
    return this.db
      .select()
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.organizationId, organizationId),
          isNull(githubInstallations.removedAt),
          isNull(githubInstallations.suspendedAt),
        ),
      );
  }

  async forOrganization(organizationId: string): Promise<GitHubInstallationRow[]> {
    return this.db.select().from(githubInstallations).where(eq(githubInstallations.organizationId, organizationId));
  }

  async byId(organizationId: string, id: string): Promise<GitHubInstallationRow | null> {
    const [row] = await this.db
      .select()
      .from(githubInstallations)
      .where(and(eq(githubInstallations.id, id), eq(githubInstallations.organizationId, organizationId)))
      .limit(1);
    return row ?? null;
  }

  // ── Webhook-driven: GitHub names the installation ──────────────────────────
  async markRemoved(installationId: number, at = new Date()): Promise<void> {
    const rows = await this.db
      .update(githubInstallations)
      .set({ removedAt: at })
      .where(eq(githubInstallations.installationId, installationId))
      .returning();
    for (const row of rows) {
      await this.db.update(repositories).set({ detachedAt: at }).where(eq(repositories.githubInstallationId, row.id));
    }
  }

  async setSuspended(installationId: number, suspended: boolean, at = new Date()): Promise<void> {
    await this.db
      .update(githubInstallations)
      .set({ suspendedAt: suspended ? at : null })
      .where(eq(githubInstallations.installationId, installationId));
  }

  async detachRepositories(installationId: number, fullNames: string[], at = new Date()): Promise<void> {
    if (fullNames.length === 0) return;
    const [installation] = await this.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId))
      .limit(1);
    if (!installation) return;
    await this.db
      .update(repositories)
      .set({ detachedAt: at })
      .where(and(eq(repositories.githubInstallationId, installation.id), inArray(repositories.fullName, fullNames)));
  }

  // ── Repositories picked from an installation ───────────────────────────────
  async addRepository(input: {
    organizationId: string;
    githubInstallationId: string;
    fullName: string;
    defaultBranch: string;
  }): Promise<RepositoryRow> {
    const [row] = await this.db
      .insert(repositories)
      .values(input)
      .onConflictDoUpdate({
        target: [repositories.organizationId, repositories.fullName],
        set: { githubInstallationId: input.githubInstallationId, defaultBranch: input.defaultBranch, detachedAt: null },
      })
      .returning();
    return row!;
  }

  async repositories(organizationId: string): Promise<RepositoryRow[]> {
    return this.db.select().from(repositories).where(eq(repositories.organizationId, organizationId));
  }

  async repository(organizationId: string, id: string): Promise<RepositoryRow | null> {
    const [row] = await this.db
      .select()
      .from(repositories)
      .where(and(eq(repositories.id, id), eq(repositories.organizationId, organizationId)))
      .limit(1);
    return row ?? null;
  }

  async removeRepository(organizationId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .update(repositories)
      .set({ detachedAt: new Date() })
      .where(and(eq(repositories.id, id), eq(repositories.organizationId, organizationId)))
      .returning();
    return rows.length > 0;
  }
}
