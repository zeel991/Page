import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * The API and the worker run in production as TypeScript under Node's type
 * stripping (`node --experimental-strip-types`), which refuses syntax that needs
 * compiling: parameter properties, enums, namespaces. Vitest compiles TypeScript
 * itself, so every other test would pass while the deployed process failed to
 * start. This loads each app's modules the way production does.
 */
const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');

describe('runs as deployed', () => {
  it.each([
    ['api', 'apps/api/src/app.ts'],
    ['api billing and limits', 'apps/api/src/billing-routes.ts'],
    ['worker', 'apps/worker/src/jobs.ts'],
    ['worker config', 'apps/worker/src/config.ts'],
  ])('%s loads under strip-only type stripping', async (_name, file) => {
    const { stderr } = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', `await import(${JSON.stringify(resolve(root, file))})`], { cwd: root, timeout: 60_000 });
    expect(stderr).toBe('');
  });
});
