import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import type { DatabaseHandle } from './client.js';

/**
 * Brings a database up to the latest schema.
 *
 * Uses Drizzle's journal (`migrations/meta/_journal.json`) and records what it
 * applied in `drizzle.__drizzle_migrations`, so every migration runs exactly once,
 * in order. The loader this replaces applied only the first file and treated
 * "already exists" as success, which would have silently skipped every later
 * migration.
 */

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export async function migrate(handle: DatabaseHandle, migrationsFolder = MIGRATIONS_DIR): Promise<void> {
  await baselineLegacySchema(handle, migrationsFolder);
  if (handle.pglite) {
    await migratePglite(handle.db as Parameters<typeof migratePglite>[0], { migrationsFolder });
  } else {
    await migratePostgres(handle.db as Parameters<typeof migratePostgres>[0], { migrationsFolder });
  }
}

/**
 * A database created by the old loader has the first migration's tables but no
 * record of having applied it, so the migrator would try to create them again and
 * fail. Record that first migration as applied — and only that one, because it is
 * the only one the old loader could ever have run.
 */
async function baselineLegacySchema(handle: DatabaseHandle, migrationsFolder: string): Promise<void> {
  const probe = await handle.db.execute<{ legacy: boolean }>(
    sql`select to_regclass('public.organizations') is not null
           and to_regclass('drizzle.__drizzle_migrations') is null as legacy`,
  );
  const rows = Array.isArray(probe) ? probe : (probe as { rows: { legacy: boolean }[] }).rows;
  if (!rows[0]?.legacy) return;

  const [first] = readMigrationFiles({ migrationsFolder });
  if (!first) return;
  await handle.db.execute(sql`create schema if not exists drizzle`);
  await handle.db.execute(
    sql`create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`,
  );
  await handle.db.execute(
    sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${first.hash}, ${first.folderMillis})`,
  );
}
