import { join } from 'node:path';
import { createDatabase, isPgliteUrl, migrate, type DatabaseHandle } from '@pager/db';

/**
 * Database bootstrap for the API process.
 *
 * The API owns the database connection. With PGlite that is a hard requirement —
 * it is an embedded engine and only one process may hold a data directory — which
 * is why the dashboard reads through this API rather than opening the store itself.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

// Relative pglite paths resolve against the repository root, so `pnpm api` and
// `pnpm api:seed` address the same store regardless of where they are invoked.
process.env.PAGER_DATA_ROOT ??= REPO_ROOT;

export const DEFAULT_DATABASE_URL = 'pglite://.pager/db';

/**
 * Open the database. Against Postgres, migrations are a release step
 * (`pnpm db:migrate`), not something every API boot races to do; an in-process
 * PGlite database has no release step, so it is migrated here. PAGER_MIGRATE_ON_BOOT=1
 * restores boot-time migration for a single-process deployment that wants it.
 */
export async function openDatabase(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL): Promise<DatabaseHandle> {
  const handle = await createDatabase(url);
  if (isPgliteUrl(url) || process.env.PAGER_MIGRATE_ON_BOOT === '1') await migrate(handle);
  return handle;
}
