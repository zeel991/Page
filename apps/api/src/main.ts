import { buildApp } from './app.ts';
import { openDatabase } from './db.ts';

const PORT = Number(process.env.PAGER_API_PORT ?? process.env.PORT ?? 4000);
// Loopback by default; a hosted API sets PAGER_API_HOST=0.0.0.0.
const HOST = process.env.PAGER_API_HOST ?? '127.0.0.1';

async function main(): Promise<void> {
  const secret = process.env.PAGER_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('PAGER_SESSION_SECRET must be set (at least 32 characters), and shared with the console.');
  }
  const handle = await openDatabase();
  const app = await buildApp({
    db: handle.db,
    sessionSecret: secret,
    webOrigin: process.env.PAGER_WEB_ORIGIN ?? 'http://127.0.0.1:4100',
    ...(process.env.LOG_LEVEL ? { logLevel: process.env.LOG_LEVEL } : {}),
  });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await app.listen({ port: PORT, host: HOST });
  console.log(`Pager Developer API listening on http://${HOST}:${PORT}`);
  console.log(`  database ${process.env.DATABASE_URL ?? 'pglite://.pager/db'}`);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
