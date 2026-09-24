import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../src/client.js';
import { MIGRATIONS_DIR, migrate } from '../src/migrate.js';
import { deployments, evidence, incidents, organizations, repositories, services } from '../src/schema.js';

/**
 * These tests run against a real Postgres engine (PGlite), not a mock. A schema that
 * merely compiles has proved nothing; this proves the DDL is valid and that the
 * constraints we rely on for safety are actually enforced by the database.
 */


async function freshDb() {
  const handle = await createDatabase('pglite://memory');
  await migrate(handle);
  return handle;
}

describe('database schema', () => {
  it('applies cleanly to a real Postgres engine', async () => {
    const { pglite, close } = await freshDb();
    const res = await pglite!.query<{ count: number }>(
      `select count(*)::int as count from information_schema.tables where table_schema = 'public'`,
    );
    expect(res.rows[0]!.count).toBeGreaterThan(20);
    await close();
  });

  it('round-trips an organization, repository, service and deployment', async () => {
    const { db, close } = await freshDb();

    const [org] = await db.insert(organizations).values({ name: 'Acme', slug: 'acme' }).returning();
    const [repo] = await db
      .insert(repositories)
      .values({ organizationId: org!.id, fullName: 'acme/checkout-api' })
      .returning();
    const [svc] = await db
      .insert(services)
      .values({ organizationId: org!.id, repositoryId: repo!.id, name: 'checkout-api' })
      .returning();
    const [dep] = await db
      .insert(deployments)
      .values({
        organizationId: org!.id,
        serviceId: svc!.id,
        repositoryId: repo!.id,
        environment: 'production',
        status: 'succeeded',
        commitSha: 'b2c3d4',
        previousCommitSha: 'a1b2c3',
        startedAt: new Date('2026-09-13T14:29:00Z'),
        deployedAt: new Date('2026-09-13T14:31:00Z'),
      })
      .returning();

    expect(dep!.commitSha).toBe('b2c3d4');
    expect(dep!.previousCommitSha).toBe('a1b2c3');
    expect(dep!.environment).toBe('production');
    await close();
  });

  it('defaults an organization to L3 autonomy', async () => {
    const { db, close } = await freshDb();
    const [org] = await db.insert(organizations).values({ name: 'A', slug: 'a' }).returning();
    expect(org!.autonomyLevel).toBe('L3');
    await close();
  });

  it('refuses evidence that no tool call produced', async () => {
    // The evidence gate is enforced by the database too, not only in application
    // code: sourceToolCallId is NOT NULL and foreign-keyed to tool_calls.
    const { db, close } = await freshDb();
    const [org] = await db.insert(organizations).values({ name: 'A', slug: 'a' }).returning();
    const [repo] = await db.insert(repositories).values({ organizationId: org!.id, fullName: 'a/b' }).returning();
    const [svc] = await db
      .insert(services)
      .values({ organizationId: org!.id, repositoryId: repo!.id, name: 's' })
      .returning();
    const [inc] = await db
      .insert(incidents)
      .values({
        organizationId: org!.id,
        serviceId: svc!.id,
        key: 'INC-1',
        state: 'INCIDENT_OPEN',
        severity: 'SEV2',
        title: 't',
      })
      .returning();

    await expect(
      db.insert(evidence).values({
        incidentId: inc!.id,
        kind: 'DATADOG_LOG',
        provenance: 'OBSERVED',
        summary: 'invented',
        // A tool call id that was never issued.
        sourceToolCallId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow();

    await close();
  });

  it('rejects an incident state outside the state machine', async () => {
    const { db, close } = await freshDb();
    const [org] = await db.insert(organizations).values({ name: 'A', slug: 'a' }).returning();
    const [repo] = await db.insert(repositories).values({ organizationId: org!.id, fullName: 'a/b' }).returning();
    const [svc] = await db
      .insert(services)
      .values({ organizationId: org!.id, repositoryId: repo!.id, name: 's' })
      .returning();

    await expect(
      db.insert(incidents).values({
        organizationId: org!.id,
        serviceId: svc!.id,
        key: 'INC-2',
        // Not a member of INCIDENT_STATES.
        state: 'TOTALLY_FINE' as never,
        severity: 'SEV2',
        title: 't',
      }),
    ).rejects.toThrow();

    await close();
  });
});

describe('migrations', () => {
  const tableExists = async (h: Awaited<ReturnType<typeof createDatabase>>, name: string) =>
    (await h.pglite!.query<{ t: string | null }>(`select to_regclass('public.${name}')::text as t`)).rows[0]!.t !== null;

  // The loader this replaced ran only the first file, so this is the regression test
  // that matters: a second migration must actually be applied.
  it('applies every migration in the journal, not just the first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pager-migrations-'));
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    writeFileSync(join(dir, '0001_probe.sql'), 'CREATE TABLE "migration_probe" ("id" integer PRIMARY KEY);');
    const journalPath = join(dir, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    journal.entries.push({ idx: 1, version: '7', when: journal.entries[0].when + 1, tag: '0001_probe', breakpoints: true });
    writeFileSync(journalPath, JSON.stringify(journal));

    const h = await createDatabase('pglite://memory');
    await migrate(h, dir);
    expect(await tableExists(h, 'migration_probe')).toBe(true);
    await h.close();
  });

  it('is a no-op the second time', async () => {
    const h = await createDatabase('pglite://memory');
    await migrate(h);
    await migrate(h);
    const applied = await h.pglite!.query<{ n: number }>('select count(*)::int as n from drizzle.__drizzle_migrations');
    expect(applied.rows[0]!.n).toBe(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).length);
    await h.close();
  });

  it('adopts a database created by the old first-file loader', async () => {
    const h = await createDatabase('pglite://memory');
    const first = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()[0]!;
    for (const stmt of readFileSync(join(MIGRATIONS_DIR, first), 'utf8').split('--> statement-breakpoint')) {
      if (stmt.trim()) await h.pglite!.exec(stmt);
    }
    await expect(migrate(h)).resolves.toBeUndefined();
    expect(await tableExists(h, 'organizations')).toBe(true);
    await h.close();
  });
});
