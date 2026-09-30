import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DockerRunner, LocalProcessRunner, dockerRunArgs, repositoryPath, type RunSpec } from '../src/runner.js';

/**
 * DockerRunner is tested against the command it builds, because this machine has
 * no Docker daemon. What these prove is that the isolation is requested; that a
 * daemon enforces it is Docker's job and was not exercised here.
 */

const spec: RunSpec = {
  command: 'node',
  args: ['--test', 'test/a.test.ts'],
  workDir: '/sandboxes/pager-sandbox-1/work',
  homeDir: '/sandboxes/pager-sandbox-1/home',
  tmpDir: '/sandboxes/pager-sandbox-1/tmp',
  env: { FORCE_COLOR: '0' },
  timeoutMs: 1000,
  maxOutputBytes: 1000,
};

const pair = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('dockerRunArgs', () => {
  const args = dockerRunArgs(spec, { image: 'node:22-bookworm-slim' }, 'pager-sandbox-abc');

  it('has no network unless the step asks for it', () => {
    expect(pair(args, '--network')).toBe('none');
    expect(pair(dockerRunArgs({ ...spec, network: true }, { image: 'i' }, 'n'), '--network')).toBe('bridge');
  });

  it('runs read-only, unprivileged and limited', () => {
    expect(args).toContain('--read-only');
    expect(pair(args, '--user')).toBe('10001:10001');
    expect(pair(args, '--cap-drop')).toBe('ALL');
    expect(pair(args, '--security-opt')).toBe('no-new-privileges');
    expect(pair(args, '--pids-limit')).toBe('512');
    expect(pair(args, '--memory')).toBe('2048m');
    expect(pair(args, '--cpus')).toBe('2');
  });

  it('mounts only the working copy, at /work', () => {
    expect(args).toContain('type=bind,source=/sandboxes/pager-sandbox-1/work,target=/work');
    expect(args.filter((a) => a.startsWith('type=bind'))).toHaveLength(1);
    expect(pair(args, '--workdir')).toBe('/work');
  });

  it('passes the allow-listed environment and nothing of the host', () => {
    const env = args.flatMap((a, i) => (args[i - 1] === '--env' ? [a] : []));
    expect(env.map((e) => e.split('=')[0]).sort()).toEqual(['CI', 'FORCE_COLOR', 'HOME', 'NODE_ENV', 'NO_COLOR', 'PATH', 'TMPDIR']);
    expect(env).toContain('HOME=/home/sandbox');
  });

  it('ends with the image and the command, as separate arguments', () => {
    expect(args.slice(-4)).toEqual(['node:22-bookworm-slim', 'node', '--test', 'test/a.test.ts']);
  });
});

describe('DockerRunner', () => {
  function fakeSpawn() {
    const calls: { command: string; args: string[] }[] = [];
    const spawnImpl = ((command: string, args: string[]) => {
      calls.push({ command, args });
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined });
      if (args[0] === 'run') {
        // A container that never finishes on its own.
      }
      return child;
    }) as never;
    return { calls, spawnImpl };
  }

  it('kills the container itself on timeout', async () => {
    const { calls, spawnImpl } = fakeSpawn();
    const runner = new DockerRunner({ image: 'node:22' }, spawnImpl);
    const pending = runner.run({ ...spec, timeoutMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    const run = calls.find((c) => c.args[0] === 'run')!;
    const kill = calls.find((c) => c.args[0] === 'kill');
    expect(kill?.args[1]).toBe(pair(run.args, '--name'));
    void pending;
  });
});

describe('binary resolution in the repository', () => {
  it('runs the repository’s own node_modules/.bin, never another project’s from the host PATH', async () => {
    const { mkdtemp, mkdir, writeFile, chmod, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'pager-bin-'));
    try {
      const other = join(root, 'host-project', 'node_modules', '.bin');
      const repo = join(root, 'repo');
      await mkdir(other, { recursive: true });
      await mkdir(join(repo, 'node_modules', '.bin'), { recursive: true });
      for (const [dir, who] of [[other, 'host'], [join(repo, 'node_modules', '.bin'), 'repository']] as const) {
        await writeFile(join(dir, 'runner-under-test'), `#!/bin/sh\necho ${who}\n`);
        await chmod(join(dir, 'runner-under-test'), 0o755);
      }
      expect(repositoryPath(repo, `${other}:/usr/bin:/bin`)).toBe(`${repo}/node_modules/.bin:/usr/bin:/bin`);

      const saved = process.env.PATH;
      process.env.PATH = `${other}:${saved}`;
      try {
        const out = await new LocalProcessRunner().run({
          command: 'runner-under-test', args: [], workDir: repo, homeDir: root, tmpDir: root, env: {}, timeoutMs: 10_000, maxOutputBytes: 1000,
        });
        expect(out.stdout.trim()).toBe('repository');
      } finally {
        process.env.PATH = saved;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
