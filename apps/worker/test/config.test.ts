import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WorkerConfigError, describeConfig, loadConfig } from '../src/config.ts';

const BASE = { DATABASE_URL: 'postgres://pager@db/pager', PAGER_MASTER_KEY: randomBytes(32).toString('base64') };
const load = (env: Record<string, string>) => () => loadConfig({ ...BASE, ...env });

describe('worker configuration', () => {
  it('needs only the operator’s settings; nothing about any tenant', () => {
    const config = loadConfig(BASE);
    expect(config.concurrency).toBe(2);
    expect(config.slackSigningSecret).toBeNull();
    // The single-tenant variables are gone: a service is configured in the console.
    expect(Object.keys(config)).not.toContain('service');
    expect(Object.keys(config)).not.toContain('repository');
  });

  it('refuses to start without a database or a valid master key', () => {
    expect(() => loadConfig({})).toThrow(WorkerConfigError);
    expect(load({ PAGER_MASTER_KEY: 'short' })).toThrow(/PAGER_MASTER_KEY/);
  });

  it.each(['0', 'abc', '1.5'])('refuses PAGER_WORKER_CONCURRENCY=%s', (value) => {
    expect(load({ PAGER_WORKER_CONCURRENCY: value })).toThrow(/PAGER_WORKER_CONCURRENCY/);
  });

  it('runs repository code locally by default, and says it is development only', () => {
    const config = loadConfig(BASE);
    expect(config.sandbox).toEqual({ runner: 'local' });
    expect(describeConfig(config)).toMatch(/LOCAL PROCESS — DEVELOPMENT ONLY/);
  });

  it('selects the docker sandbox, and refuses an unknown runner', () => {
    expect(loadConfig({ ...BASE, PAGER_SANDBOX_RUNNER: 'docker' }).sandbox).toEqual({ runner: 'docker', image: 'node:22-bookworm-slim' });
    expect(load({ PAGER_SANDBOX_RUNNER: 'chroot' })).toThrow(/PAGER_SANDBOX_RUNNER/);
  });

  it('never logs a secret', () => {
    const config = loadConfig({ ...BASE, SLACK_SIGNING_SECRET: 'sss-signing-secret', ANTHROPIC_API_KEY: 'sk-ant-xyz' });
    const text = describeConfig(config);
    expect(text).not.toContain('sss-signing-secret');
    expect(text).not.toContain('sk-ant-xyz');
    expect(text).not.toContain(BASE.PAGER_MASTER_KEY);
  });
});
