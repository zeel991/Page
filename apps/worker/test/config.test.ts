import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WorkerConfigError, describeConfig, loadConfig } from '../src/config.ts';

const BASE = {
  DATABASE_URL: 'postgres://pager@db/pager',
  PAGER_MASTER_KEY: randomBytes(32).toString('base64'),
  PAGER_SANDBOX_RUNNER: 'docker',
  PAGER_SANDBOX_IMAGE: 'pager-sandbox:latest',
};
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

  // Repository code under the local runner can read the worker's own environment,
  // and with it every workspace's secrets. Before, an unset runner against a real
  // database started without complaint.
  it('refuses the local sandbox against a real database unless every workspace is trusted', () => {
    expect(load({ PAGER_SANDBOX_RUNNER: '' })).toThrow(/could read its credentials/);
    expect(load({ PAGER_SANDBOX_RUNNER: 'local' })).toThrow(/PAGER_ALLOW_LOCAL_SANDBOX=1/);
    const trusted = loadConfig({ ...BASE, PAGER_SANDBOX_RUNNER: 'local', PAGER_ALLOW_LOCAL_SANDBOX: '1' });
    expect(trusted.sandbox).toEqual({ runner: 'local', root: undefined });
    expect(describeConfig(trusted)).toMatch(/LOCAL PROCESS — TRUSTED WORKSPACES ONLY/);
  });

  it('runs locally against an in-process development database', () => {
    const config = loadConfig({ ...BASE, DATABASE_URL: 'pglite://memory', PAGER_SANDBOX_RUNNER: '' });
    expect(config.sandbox.runner).toBe('local');
  });

  it('selects the docker sandbox with its image, runtime and root, and refuses an unknown runner', () => {
    expect(loadConfig({ ...BASE, PAGER_SANDBOX_DOCKER_RUNTIME: 'runsc', PAGER_SANDBOX_ROOT: '/var/lib/pager/sandboxes' }).sandbox).toEqual({
      runner: 'docker',
      image: 'pager-sandbox:latest',
      runtime: 'runsc',
      root: '/var/lib/pager/sandboxes',
    });
    expect(load({ PAGER_SANDBOX_IMAGE: '' })).toThrow(/PAGER_SANDBOX_IMAGE is required/);
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
