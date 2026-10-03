import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DockerRunner, LocalProcessRunner, containerUser, dockerClientEnvironment, dockerRunArgs, repositoryPath, type RunSpec } from '../src/runner.js';

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
  const args = dockerRunArgs(spec, { image: 'node:22-bookworm-slim', user: '1000:1000' }, 'pager-sandbox-abc');

  it('has no network unless the step asks for it', () => {
    expect(pair(args, '--network')).toBe('none');
    expect(pair(dockerRunArgs({ ...spec, network: true }, { image: 'i' }, 'n'), '--network')).toBe('bridge');
  });

  it('runs read-only, unprivileged and limited', () => {
    expect(args).toContain('--read-only');
    expect(pair(args, '--user')).toBe('1000:1000');
    expect(pair(args, '--cap-drop')).toBe('ALL');
    expect(pair(args, '--security-opt')).toBe('no-new-privileges');
    expect(pair(args, '--pids-limit')).toBe('512');
    expect(pair(args, '--memory')).toBe('2048m');
    expect(pair(args, '--cpus')).toBe('2');
  });

  it('mounts only the sandbox’s own directories: the working copy, its home and its temp', () => {
    expect(args.filter((a) => a.startsWith('type=bind'))).toEqual([
      'type=bind,source=/sandboxes/pager-sandbox-1/work,target=/work',
      'type=bind,source=/sandboxes/pager-sandbox-1/home,target=/home/sandbox',
      'type=bind,source=/sandboxes/pager-sandbox-1/tmp,target=/tmp',
    ]);
    expect(pair(args, '--workdir')).toBe('/work');
  });

  it('runs an init as pid 1, and a stronger runtime when one is configured', () => {
    expect(args).toContain('--init');
    expect(args).not.toContain('--runtime');
    expect(pair(dockerRunArgs(spec, { image: 'i', user: '1:1', runtime: 'runsc' }, 'n'), '--runtime')).toBe('runsc');
  });

  it('passes the allow-listed environment and nothing of the host', () => {
    const env = args.flatMap((a, i) => (args[i - 1] === '--env' ? [a] : []));
    expect(env.map((e) => e.split('=')[0]).sort()).toEqual(['CI', 'FORCE_COLOR', 'HOME', 'NODE_ENV', 'NO_COLOR', 'PATH', 'PYTHONDONTWRITEBYTECODE', 'TMPDIR']);
    expect(env).toContain('HOME=/home/sandbox');
  });

  it('ends with the image and the command, as separate arguments', () => {
    expect(args.slice(-4)).toEqual(['node:22-bookworm-slim', 'node', '--test', 'test/a.test.ts']);
  });
});

describe('containerUser', () => {
  // The bind-mounted working copy belongs to the worker's user. A container running
  // as a fixed uid 10001 could not write node_modules, .venv or a patch into it.
  it('is the worker’s own uid:gid, so the mounted sandbox is writable', () => {
    expect(containerUser({ uid: 1001, gid: 118 })).toBe('1001:118');
  });

  it('refuses root', () => {
    expect(() => containerUser({ uid: 0, gid: 0 })).toThrow(/not run repository code as root/);
  });

  it('keys installs by image, not only by runner kind', () => {
    expect(new DockerRunner({ image: 'pager-sandbox:1', user: '1:1' }).cacheScope).not.toBe(new DockerRunner({ image: 'pager-sandbox:2', user: '1:1' }).cacheScope);
  });
});

describe('dockerClientEnvironment', () => {
  // A worker using a non-default daemon (Colima, a remote context) set DOCKER_HOST,
  // and the client never saw it: it was given PATH and HOME only.
  it('passes which daemon to use, and nothing else of the worker’s', () => {
    const env = dockerClientEnvironment(
      { PATH: '/bin', DOCKER_HOST: 'unix:///Users/x/.colima/default/docker.sock', DOCKER_CONTEXT: 'colima', PAGER_MASTER_KEY: 'secret', HOME: '/Users/x' },
      '/sandbox/home',
    );
    expect(env).toEqual({ PATH: '/bin', HOME: '/sandbox/home', DOCKER_HOST: 'unix:///Users/x/.colima/default/docker.sock', DOCKER_CONTEXT: 'colima' });
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
