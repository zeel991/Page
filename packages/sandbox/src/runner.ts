import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { redactSecrets } from '@pager/core';

/**
 * Where a sandboxed command actually runs.
 *
 * The repository under investigation is untrusted code: its tests, its build and
 * anything a model wrote into it are executed. The runner is the boundary between
 * that code and this machine, so it is an interface with two implementations of
 * very different strength:
 *
 *  - `LocalProcessRunner` — a child process on this host, in a temporary directory,
 *    with an allow-listed environment and its whole process group killed on timeout.
 *    It shares this host's filesystem, network and user. **Development only.** It is
 *    what runs when nothing else is configured, and it says so.
 *  - `DockerRunner` — a container with no network (unless a step asks for it, as a
 *    dependency install does), a read-only root filesystem, CPU, memory and pid
 *    limits, a non-root uid, all capabilities dropped, and the repository mounted
 *    at `/work`. This is the production boundary.
 */

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RunSpec {
  command: string;
  args: string[];
  /** Host path of the repository working copy. */
  workDir: string;
  /** Host path of a writable, empty home directory for this sandbox. */
  homeDir: string;
  /** Host path of a writable temporary directory for this sandbox. */
  tmpDir: string;
  /** Extra variables for this command, over the allow-listed base. */
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Network access. Off unless a step needs it (dependency install). */
  network?: boolean;
}

export interface SandboxRunner {
  readonly kind: 'local-process' | 'docker';
  /** One line for logs and the dashboard: what isolation this actually provides. */
  readonly description: string;
  run(spec: RunSpec): Promise<CommandResult>;
}

/**
 * The environment a sandboxed command gets: an allow-list, not a scrub.
 *
 * Scrubbing by name pattern let through everything not named like a secret —
 * `HOME` (and with it `~/.ssh`, `~/.aws`, `~/.npmrc`), `SSH_AUTH_SOCK`, cloud
 * metadata variables. Now nothing of this process's environment passes except PATH,
 * and HOME and TMPDIR point inside the sandbox.
 */
export function sandboxEnvironment(opts: {
  path: string | undefined;
  home: string;
  tmp: string;
  extra?: Record<string, string>;
}): Record<string, string> {
  return {
    PATH: opts.path ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: opts.home,
    TMPDIR: opts.tmp,
    CI: '1',
    // CI=1 turns colour ON in several runners (vitest's among them); escape codes in
    // the output would defeat every pattern that reads it.
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    NODE_ENV: 'test',
    ...(opts.extra ?? {}),
  };
}

type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/**
 * Spawn a process in its own group, capture capped output, and kill the whole
 * group on timeout.
 *
 * Killing only the direct child let grandchildren survive — `pnpm test` starts
 * `node`, which starts workers — so a timed-out suite kept running after the
 * incident had moved on. The group is also killed when the command exits, so
 * nothing it left in the background outlives it.
 */
export function runProcess(
  spawnImpl: Spawn,
  command: string,
  args: string[],
  opts: { cwd?: string; env: Record<string, string>; timeoutMs: number; maxOutputBytes: number; onTimeout?: () => void },
): Promise<CommandResult> {
  const started = Date.now();
  const display = [command, ...args].join(' ');

  return new Promise<CommandResult>((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(command, args, {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        env: opts.env,
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolvePromise({
        command: display,
        exitCode: 127,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
        timedOut: false,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        // A negative pid addresses the process group the detached child leads.
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    };

    const capture = (chunk: Buffer, into: 'out' | 'err'): void => {
      const text = chunk.toString('utf8');
      if (into === 'out') {
        if (stdout.length < opts.maxOutputBytes) stdout += text.slice(0, opts.maxOutputBytes - stdout.length);
      } else if (stderr.length < opts.maxOutputBytes) {
        stderr += text.slice(0, opts.maxOutputBytes - stderr.length);
      }
    };

    child.stdout?.on('data', (c: Buffer) => capture(c, 'out'));
    child.stderr?.on('data', (c: Buffer) => capture(c, 'err'));

    const timer = setTimeout(() => {
      timedOut = true;
      opts.onTimeout?.();
      killGroup();
    }, opts.timeoutMs);

    const finish = (exitCode: number, extraErr = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup();
      // Repository code can print anything it can read, credentials included.
      resolvePromise({
        command: redactSecrets(display),
        exitCode,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(`${stderr}${extraErr}`),
        durationMs: Date.now() - started,
        timedOut,
      });
    };

    // 127 is the conventional "command not found", and a missing binary must never
    // look like a passing run.
    child.on('error', (err) => finish(127, err.message));
    // The direct child exiting is the end of the command. Stragglers in its group
    // are killed rather than waited for — they would hold the pipes open — and the
    // result is taken once the pipes drain, so no trailing output is lost. A
    // process that escaped the group could still hold them; the grace timer bounds
    // that.
    let exitCode: number | null = null;
    child.on('exit', (code) => {
      exitCode = code ?? (timedOut ? 124 : 1);
      killGroup();
      setTimeout(() => finish(exitCode!), 2_000).unref();
    });
    child.on('close', (code) => finish(exitCode ?? code ?? (timedOut ? 124 : 1)));
  });
}

/**
 * PATH for a command in the repository: its own `node_modules/.bin` first, as `npm
 * run` would, and no other project's. A host PATH inherited through a package
 * manager carries that project's `.bin` directories, and without this the
 * repository's `vitest` resolved to whichever vitest the host happened to have.
 */
export function repositoryPath(workDir: string, hostPath: string | undefined, sep = ':'): string {
  const host = (hostPath ?? '/usr/local/bin:/usr/bin:/bin').split(sep).filter((p) => p && !/[\\/]node_modules[\\/]\.bin[\\/]?$/.test(p));
  return [`${workDir}/node_modules/.bin`, ...host].join(sep);
}

/** Development only: runs on this host, as this user, with this host's network. */
export class LocalProcessRunner implements SandboxRunner {
  readonly kind = 'local-process' as const;
  readonly description =
    'LocalProcessRunner (DEVELOPMENT ONLY): repository code runs on this host as this user, with host ' +
    'network and filesystem access; only the environment, working directory and process lifetime are contained.';

  constructor(private readonly spawnImpl: Spawn = spawn) {}

  run(spec: RunSpec): Promise<CommandResult> {
    return runProcess(this.spawnImpl, spec.command, spec.args, {
      cwd: spec.workDir,
      env: sandboxEnvironment({ path: repositoryPath(spec.workDir, process.env.PATH), home: spec.homeDir, tmp: spec.tmpDir, extra: spec.env }),
      timeoutMs: spec.timeoutMs,
      maxOutputBytes: spec.maxOutputBytes,
    });
  }
}

export interface DockerRunnerOptions {
  /** Image with the language toolchain, e.g. `node:22-bookworm-slim`. */
  image: string;
  /** Defaults: 2 CPUs, 2 GiB, 512 pids, uid 10001, 512 MiB of /tmp. */
  cpus?: number;
  memoryMb?: number;
  pids?: number;
  user?: string;
  tmpfsMb?: number;
  /** The docker CLI. */
  dockerBin?: string;
}

/**
 * The `docker run` argument vector for one command.
 *
 * Pure, so the isolation it asks for can be asserted without a daemon.
 */
export function dockerRunArgs(spec: RunSpec, opts: DockerRunnerOptions, containerName: string): string[] {
  const env = sandboxEnvironment({
    path: '/work/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    home: '/home/sandbox',
    tmp: '/tmp',
    extra: spec.env,
  });
  return [
    'run',
    '--rm',
    '--name', containerName,
    '--network', spec.network ? 'bridge' : 'none',
    '--read-only',
    '--tmpfs', `/tmp:rw,nosuid,nodev,size=${opts.tmpfsMb ?? 512}m`,
    '--tmpfs', `/home/sandbox:rw,nosuid,nodev,size=64m`,
    '--cpus', String(opts.cpus ?? 2),
    '--memory', `${opts.memoryMb ?? 2048}m`,
    '--memory-swap', `${opts.memoryMb ?? 2048}m`,
    '--pids-limit', String(opts.pids ?? 512),
    '--user', opts.user ?? '10001:10001',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--mount', `type=bind,source=${spec.workDir},target=/work`,
    '--workdir', '/work',
    ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    opts.image,
    spec.command,
    ...spec.args,
  ];
}

/**
 * Runs each command in a fresh container.
 *
 * Requires a Docker daemon that can bind-mount the sandbox directory (a local
 * daemon, or a remote one sharing the filesystem). On timeout the container itself
 * is killed, since killing the `docker` client does not stop it.
 */
export class DockerRunner implements SandboxRunner {
  readonly kind = 'docker' as const;
  readonly description: string;

  constructor(
    private readonly opts: DockerRunnerOptions,
    private readonly spawnImpl: Spawn = spawn,
  ) {
    this.description =
      `DockerRunner (${opts.image}): no network outside dependency install, read-only root, ` +
      `non-root uid, CPU/memory/pid limits, repository at /work.`;
  }

  run(spec: RunSpec): Promise<CommandResult> {
    const docker = this.opts.dockerBin ?? 'docker';
    const name = `pager-sandbox-${randomBytes(6).toString('hex')}`;
    return runProcess(this.spawnImpl, docker, dockerRunArgs(spec, this.opts, name), {
      // The docker client needs a PATH and nothing else of ours.
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: spec.homeDir },
      timeoutMs: spec.timeoutMs,
      maxOutputBytes: spec.maxOutputBytes,
      onTimeout: () => {
        const killer = this.spawnImpl(docker, ['kill', name], { stdio: 'ignore', detached: true, shell: false });
        killer.on('error', () => undefined);
      },
    });
  }
}
