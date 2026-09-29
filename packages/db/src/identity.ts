import { and, asc, eq } from 'drizzle-orm';
import type { Database } from './client.js';
import { memberships, organizations, policies, users } from './schema.js';

/**
 * People, workspaces and who belongs to which.
 *
 * Signing in is keyed on the provider's stable subject (GitHub's numeric user id),
 * never the login or the email: a login can be renamed and then claimed by someone
 * else, and an email is optional and unverified.
 */

export type UserRow = typeof users.$inferSelect;
export type MembershipRow = typeof memberships.$inferSelect;
export type OrganizationRow = typeof organizations.$inferSelect;
export type Role = MembershipRow['role'];

export interface SignInProfile {
  provider: 'github';
  subject: string;
  login: string | null;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

/**
 * The actions every new workspace starts with, as policy rows the console shows and
 * an owner can review. They restate what the code enforces; they cannot loosen it.
 */
export const DEFAULT_POLICIES: Omit<typeof policies.$inferInsert, 'organizationId'>[] = [
  {
    name: 'Open a pull request',
    description: 'Create a fix branch and open a pull request for human review.',
    minAutonomy: 'L3',
    requiresApproval: false,
    appliesToRisk: 'WRITE_NON_PRODUCTION',
  },
  {
    name: 'Merge a pull request',
    description: 'Merge a reviewed pull request, only on a recorded click by an owner or admin.',
    minAutonomy: 'L4',
    requiresApproval: true,
    appliesToRisk: 'PRODUCTION_WRITE',
  },
  {
    name: 'Roll back a deployment',
    description: 'Not offered: Pager Developer never deploys.',
    minAutonomy: 'L4',
    requiresApproval: true,
    appliesToRisk: 'PRODUCTION_WRITE',
    enabled: false,
  },
];

function slugify(input: string): string {
  const s = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'workspace';
}

export class IdentityRepository {
  constructor(private readonly db: Database) {}

  /**
   * Record a sign-in. A person signing in for the first time gets a workspace of
   * their own, with themselves as owner; everyone else keeps the workspaces they have.
   */
  async signIn(profile: SignInProfile, now = new Date()): Promise<{ user: UserRow; workspaces: Workspace[]; created: boolean }> {
    const values = {
      authProvider: profile.provider,
      providerSubject: profile.subject,
      login: profile.login,
      email: profile.email,
      name: profile.name ?? profile.login ?? 'Unnamed',
      avatarUrl: profile.avatarUrl,
      lastSignInAt: now,
    };
    const [user] = await this.db
      .insert(users)
      .values(values)
      .onConflictDoUpdate({
        target: [users.authProvider, users.providerSubject],
        set: { login: values.login, email: values.email, name: values.name, avatarUrl: values.avatarUrl, lastSignInAt: now },
      })
      .returning();

    let workspaces = await this.workspacesFor(user!.id);
    let created = false;
    if (workspaces.length === 0) {
      await this.createWorkspace(user!.id, `${profile.login ?? values.name}'s workspace`);
      workspaces = await this.workspacesFor(user!.id);
      created = true;
    }
    return { user: user!, workspaces, created };
  }

  /** A new workspace, owned by `ownerId`, with the default policies. */
  async createWorkspace(ownerId: string, name: string): Promise<OrganizationRow> {
    const base = slugify(name);
    let org: OrganizationRow | undefined;
    for (let attempt = 0; !org; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 7)}`;
      const [row] = await this.db.insert(organizations).values({ name, slug }).onConflictDoNothing().returning();
      org = row;
      if (attempt > 5 && !org) throw new Error('could not allocate a workspace slug');
    }
    await this.db.insert(memberships).values({ userId: ownerId, organizationId: org.id, role: 'owner' });
    await this.db.insert(policies).values(DEFAULT_POLICIES.map((p) => ({ ...p, organizationId: org!.id })));
    return org;
  }

  async workspacesFor(userId: string): Promise<Workspace[]> {
    const rows = await this.db
      .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, role: memberships.role })
      .from(memberships)
      .innerJoin(organizations, eq(memberships.organizationId, organizations.id))
      .where(eq(memberships.userId, userId))
      .orderBy(asc(memberships.createdAt));
    return rows;
  }

  /** The membership that authorises `userId` to act in `organizationId`, or null. */
  async membership(userId: string, organizationId: string): Promise<MembershipRow | null> {
    const [row] = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, organizationId)))
      .limit(1);
    return row ?? null;
  }

  async user(userId: string): Promise<UserRow | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    return row ?? null;
  }

  async members(organizationId: string): Promise<(MembershipRow & { user: UserRow })[]> {
    const rows = await this.db
      .select()
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(eq(memberships.organizationId, organizationId))
      .orderBy(asc(memberships.createdAt));
    return rows.map((r) => ({ ...r.memberships, user: r.users }));
  }
}
