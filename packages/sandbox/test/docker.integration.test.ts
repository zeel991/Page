import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { DockerRunner } from '../src/runner.js';
import { Sandbox } from '../src/sandbox.js';

/**
 * DockerRunner against a real daemon and the real sandbox image.
 *
 *   docker build -f docker/sandbox.Dockerfile -t pager-sandbox:ci .
 *   PAGER_TEST_DOCKER_IMAGE=pager-sandbox:ci npx vitest run packages/sandbox/test/docker.integration.test.ts
 *
 * Skipped without PAGER_TEST_DOCKER_IMAGE, since most machines this runs on have no
 * daemon; CI's sandbox-docker job sets it. These are the properties open sign-up
 * rests on: that a daemon enforces what `dockerRunArgs` asks for.
 */
const image = process.env.PAGER_TEST_DOCKER_IMAGE;

describe.skipIf(!image)('DockerRunner against a daemon', () => {
  const runner = () => new DockerRunner({ image: image! });
  const node = async (sandbox: Sandbox, script: string, opts: { network?: boolean; timeoutMs?: number } = {}) =>
    sandbox.run('node', ['-e', script], { timeoutMs: opts.timeoutMs ?? 60_000, ...(opts.network ? { network: true } : {}) });
  const withSandbox = async (fn: (s: Sandbox) => Promise<void>) => {
    const sandbox = await Sandbox.fromFiles({ 'README.md': 'x\n' }, 'test', { runner: runner() });
    try {
      await fn(sandbox);
    } finally {
      await sandbox.dispose();
    }
  };

  it('runs as the worker’s own unprivileged uid, and can write the repository, its home and its temp', async () => {
    await withSandbox(async (s) => {
      const r = await node(s, `
        const fs = require('node:fs');
        fs.writeFileSync('/work/written.txt', 'ok');
        fs.writeFileSync('/home/sandbox/h', 'ok');
        fs.writeFileSync('/tmp/t', 'ok');
        console.log(process.getuid());`);
      expect(r.stderr).toBe('');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe(String(process.getuid!()));
      expect(await s.readFile('written.txt')).toBe('ok');
    });
  });

  it('has a read-only root filesystem', async () => {
    await withSandbox(async (s) => {
      const r = await node(s, `require('node:fs').writeFileSync('/usr/local/bin/planted', 'x')`);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toMatch(/EROFS|read-only/i);
    });
  });

  it('has no network unless the step asks for it', async () => {
    const probe = `fetch('https://registry.npmjs.org/', { signal: AbortSignal.timeout(10000) }).then((r) => console.log('status', r.status), (e) => { console.log('refused', e.cause?.code ?? e.name); process.exit(3); })`;
    await withSandbox(async (s) => {
      const offline = await node(s, probe);
      expect(offline.exitCode).toBe(3);
      const online = await node(s, probe, { network: true });
      expect(online.stdout).toMatch(/status 200/);
    });
  });

  it('sees none of the worker’s environment', async () => {
    process.env.PAGER_TEST_CANARY = 'canary-value-that-must-not-leak';
    try {
      await withSandbox(async (s) => {
        // Its own environment, and pid 1's: /proc shows only this container's processes.
        const r = await node(s, `console.log(JSON.stringify(process.env)); try { console.log(require('node:fs').readFileSync('/proc/1/environ', 'utf8')) } catch { console.log('pid 1 unreadable') }`);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).not.toContain('canary-value-that-must-not-leak');
        expect(r.stdout).not.toContain('PAGER_MASTER_KEY');
      });
    } finally {
      delete process.env.PAGER_TEST_CANARY;
    }
  });

  it('kills the container on timeout, not only the client', async () => {
    await withSandbox(async (s) => {
      const r = await node(s, 'setInterval(() => {}, 1000)', { timeoutMs: 3_000 });
      expect(r.timedOut).toBe(true);
      await new Promise((done) => setTimeout(done, 2_000));
      const { stdout } = await promisify(execFile)('docker', ['ps', '--filter', 'name=pager-sandbox-', '--format', '{{.Names}}']);
      expect(stdout.trim()).toBe('');
    });
  });

  it('carries every toolchain a supported repository needs', async () => {
    await withSandbox(async (s) => {
      for (const [command, args] of [['pnpm', ['--version']], ['yarn', ['--version']], ['npm', ['--version']], ['uv', ['--version']], ['python3', ['-c', 'import venv; print("venv")']]] as const) {
        const r = await s.run(command, [...args], { timeoutMs: 60_000 });
        expect(r.exitCode, `${command}: ${r.stderr}`).toBe(0);
      }
    });
  });
});
