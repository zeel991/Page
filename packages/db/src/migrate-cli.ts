/**
 * `pnpm db:migrate` — bring DATABASE_URL up to the latest schema, then exit.
 *
 * The release step. Against Postgres, neither the API nor the worker migrates on
 * boot: two processes starting at once would race the same DDL, and a deploy whose
 * migration fails should stop before any new code serves traffic.
 */
import { createDatabase } from './client.js';
import { migrate } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}
const handle = await createDatabase(url, { max: 1 });
try {
  await migrate(handle);
  console.log('migrations applied');
} finally {
  await handle.close();
}
