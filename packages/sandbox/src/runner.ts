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
 *    limits, a non-root uid, all capabilities dropped, and only this sandbox's own
 *    directories mounted: the repository at `/work`, its home and its temp. This is
 *    the production boundary.
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
  /**
   * What makes two installs by this runner interchangeable, beyond its kind: a tree
   * installed in one image is not the tree another image would have produced.
   */
  readonly cacheScope?: string;
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
    // Python validates cached bytecode by source size and mtime (whole seconds), so a
    // patch the same length as the line it replaces, written within the second, ran
    // the old code. No cache is written, so the code that runs is the code on disk.
    PYTHONDONTWRITEBYTECODE: '1',
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
  /** Image with the language toolchains: `docker/sandbox.Dockerfile`. */
  image: string;
  /** Defaults: 2 CPUs, 2 GiB, 512 pids. */
  cpus?: number;
  memoryMb?: number;
  pids?: number;
  /**
   * `uid:gid` inside the container. Defaults to this process's own, so the
   * bind-mounted sandbox is writable and nothing it writes is owned by anyone else.
   */
  user?: string;
  /** An OCI runtime, e.g. `runsc` (gVisor), for a kernel boundary as well. */
  runtime?: string;
  /** The docker CLI. */
  dockerBin?: string;
}

/**
 * This process's `uid:gid`, which the container runs as.
 *
 * Refused when it is root: a container running as uid 0 is root on the host's
 * files it mounts, and a worker running as root has no reason to.
 */
export function containerUser(ids: { uid: number | undefined; gid: number | undefined } = { uid: process.getuid?.(), gid: process.getgid?.() }): string {
  if (ids.uid === undefined || ids.gid === undefined) {
    throw new Error('DockerRunner needs a uid:gid to run as: pass `user`, or run on a platform with process.getuid().');
  }
  if (ids.uid === 0) {
    throw new Error('DockerRunner will not run repository code as root. Run the worker as an unprivileged user in the docker group, or pass `user`.');
  }
  return `${ids.uid}:${ids.gid}`;
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
    // An init as pid 1, so signals reach the command and its children are reaped.
    '--init',
    ...(opts.runtime ? ['--runtime', opts.runtime] : []),
    '--network', spec.network ? 'bridge' : 'none',
    '--read-only',
    '--cpus', String(opts.cpus ?? 2),
    '--memory', `${opts.memoryMb ?? 2048}m`,
    '--memory-swap', `${opts.memoryMb ?? 2048}m`,
    '--pids-limit', String(opts.pids ?? 512),
    '--user', opts.user ?? containerUser(),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    // Home and temp are the sandbox's own directories on disk, not tmpfs: a package
    // manager's cache (npm's, pnpm's store, uv's) does not fit in memory-backed
    // space sized for scratch files, and tmpfs counts against the memory limit.
    '--mount', `type=bind,source=${spec.workDir},target=/work`,
    '--mount', `type=bind,source=${spec.homeDir},target=/home/sandbox`,
    '--mount', `type=bind,source=${spec.tmpDir},target=/tmp`,
    '--workdir', '/work',
    ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    opts.image,
    spec.command,
    ...spec.args,
  ];
}

/** Docker's own settings for reaching its daemon, the only ones the client is given. */
const DOCKER_CLIENT_SETTINGS = ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'] as const;

/**
 * The environment of the `docker` client itself (not of the container): a PATH, a
 * HOME inside the sandbox, and the settings that say which daemon to use. Without
 * them the client fell back to its default socket, so a worker pointed at a
 * non-default daemon (Colima's, a remote host's) could not start a sandbox.
 */
export function dockerClientEnvironment(env: NodeJS.ProcessEnv, homeDir: string): Record<string, string> {
  const out: Record<string, string> = { PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: homeDir };
  for (const key of DOCKER_CLIENT_SETTINGS) {
    const value = env[key];
    if (value) out[key] = value;
  }
  return out;
}

/**
 * Runs each command in a fresh container.
 *
 * Requires a Docker daemon that can bind-mount the sandbox directory at the same
 * path this process sees it: a local daemon, or, when the worker itself runs in a
 * container with the daemon's socket, a sandbox root mounted at an identical path in
 * both. On timeout the container itself is killed, since killing the `docker` client
 * does not stop it.
 */
export class DockerRunner implements SandboxRunner {
  readonly kind = 'docker' as const;
  readonly description: string;
  readonly cacheScope: string;
  private readonly opts: DockerRunnerOptions;

  constructor(
    opts: DockerRunnerOptions,
    private readonly spawnImpl: Spawn = spawn,
  ) {
    // Resolved once, so a worker running as root fails at boot, not at the first incident.
    this.opts = { ...opts, user: opts.user ?? containerUser() };
    this.cacheScope = `docker:${opts.image}`;
    this.description =
      `DockerRunner (${opts.image}${opts.runtime ? `, runtime ${opts.runtime}` : ''}): no network outside ` +
      `dependency install, read-only root, uid ${this.opts.user}, no capabilities, CPU/memory/pid limits, ` +
      `only the sandbox's own directories mounted.`;
  }

  run(spec: RunSpec): Promise<CommandResult> {
    const docker = this.opts.dockerBin ?? 'docker';
    const name = `pager-sandbox-${randomBytes(6).toString('hex')}`;
    return runProcess(this.spawnImpl, docker, dockerRunArgs(spec, this.opts, name), {
      env: dockerClientEnvironment(process.env, spec.homeDir),
      timeoutMs: spec.timeoutMs,
      maxOutputBytes: spec.maxOutputBytes,
      onTimeout: () => {
        const killer = this.spawnImpl(docker, ['kill', name], { stdio: 'ignore', detached: true, shell: false });
        killer.on('error', () => undefined);
      },
    });
  }
}
