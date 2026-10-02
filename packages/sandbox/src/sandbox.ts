import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { devNull, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import type { SourceControlProvider } from '@pager/providers';
import { ProtectedPathError, protectedPathReason } from './patch-policy.js';
import { LocalProcessRunner, runProcess, type CommandResult, type SandboxRunner } from './runner.js';

export type { CommandResult } from './runner.js';

/**
 * An isolated working copy.
 *
 * Pager reproduces failures and writes patches by running real commands, which is the
 * only way "the tests pass" can mean anything. That makes containment the safety
 * property that matters most here:
 *
 *  - Every sandbox is a fresh temporary directory. The developer's working tree and
 *    the production filesystem are never touched.
 *  - Path arguments are resolved and checked to stay inside the sandbox, so a patch
 *    naming `../../.ssh/config` is refused rather than written.
 *  - Commands get an allow-listed environment — PATH, and a HOME and TMPDIR inside
 *    the sandbox — so this process's credentials are not inherited, and tools that
 *    find `~/.npmrc`, `~/.aws` or `~/.ssh` through HOME find an empty directory.
 *    On the local runner that is all: the code runs as this user and can still
 *    open any file this user can by absolute path. Only `DockerRunner` stops that.
 *  - Every command has a timeout, enforced on its whole process group, and an
 *    output cap, so a runaway test suite fails the run instead of hanging the
 *    incident.
 *  - Where a command runs is a `SandboxRunner`. The default runs on this host and
 *    is for development only; `DockerRunner` is the production boundary.
 */

export class SandboxPathError extends Error {
  constructor(readonly path: string) {
    super(`Refused a path outside the sandbox: ${path}`);
    this.name = 'SandboxPathError';
  }
}

export interface RunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Extra variables for this command. Merged over the allow-listed base. */
  env?: Record<string, string>;
  /** Network access for this command. Only a dependency install should ask for it. */
  network?: boolean;
}

export interface SandboxOptions {
  /** Parent directory for sandboxes. Defaults to the OS temp directory. */
  rootDir?: string;
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
  /** Where commands run. Defaults to `LocalProcessRunner`, which is for development only. */
  runner?: SandboxRunner;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 1_000_000;
const CLONE_TIMEOUT_MS = 180_000;
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache']);

export class Sandbox {
  readonly runner: SandboxRunner;

  private constructor(
    /** Everything this sandbox owns: `work/` (the repository), `home/`, `tmp/`. */
    readonly root: string,
    /** The repository working copy. */
    readonly dir: string,
    readonly revision: string,
    private readonly opts: SandboxOptions,
  ) {
    this.runner = opts.runner ?? new LocalProcessRunner();
  }

  /**
   * Materialise a repository at an exact revision: a shallow, blob-filtered git
   * clone of that one commit.
   *
   * A clone rather than one API read per file: it is one round trip instead of
   * hundreds, it is byte-exact (binary files survive, where decoding every file as
   * UTF-8 corrupted them), and it cannot silently come back partial the way a
   * truncated listing could. Git runs on this host — no repository code runs at this
   * stage — with the credential in its environment only (`gitAuthEnvironment`), never
   * in the URL, argv or `.git/config`, and with no user or system git config.
   */
  static async create(
    provider: Pick<SourceControlProvider, 'cloneUrl' | 'gitAuthEnvironment'>,
    repo: string,
    revision: string,
    opts: SandboxOptions = {},
  ): Promise<Sandbox> {
    const sandbox = await Sandbox.empty(revision, opts);
    try {
      const env = {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: join(sandbox.root, 'home'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: devNull,
        ...(await provider.gitAuthEnvironment()),
      };
      const git = async (args: string[], timeoutMs = CLONE_TIMEOUT_MS): Promise<CommandResult> => {
        const result = await runProcess(spawn, 'git', args, { cwd: sandbox.dir, env, timeoutMs, maxOutputBytes: 200_000 });
        if (result.exitCode !== 0) {
          throw new Error(
            `Cannot build a sandbox: \`git ${args[0]}\` of ${repo}@${revision} failed (exit ${result.exitCode}` +
              `${result.timedOut ? ', timed out' : ''}): ${result.stderr.trim().slice(0, 500) || 'no output'}`,
          );
        }
        return result;
      };
      await git(['init', '-q']);
      await git(['remote', 'add', 'origin', provider.cloneUrl(repo)]);
      await git(['fetch', '-q', '--no-tags', '--depth', '1', '--filter=blob:none', 'origin', revision]);
      await git(['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD']);
      const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      // A tree that is not the pinned one would reproduce against the wrong code.
      if (/^[0-9a-f]{40}$/i.test(revision) && head.toLowerCase() !== revision.toLowerCase()) {
        throw new Error(`Cannot build a sandbox: asked for ${revision} but the clone checked out ${head}.`);
      }
      return sandbox;
    } catch (err) {
      await sandbox.dispose();
      throw err;
    }
  }

  /** A sandbox holding exactly these files. For tests and scripted fixtures. */
  static async fromFiles(files: Readonly<Record<string, string>>, revision: string, opts: SandboxOptions = {}): Promise<Sandbox> {
    const sandbox = await Sandbox.empty(revision, opts);
    for (const [path, content] of Object.entries(files)) await sandbox.writeFile(path, content);
    return sandbox;
  }

  private static async empty(revision: string, opts: SandboxOptions): Promise<Sandbox> {
    const parent = opts.rootDir ?? tmpdir();
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, 'pager-sandbox-'));
    // Home and temp are siblings of the working copy, not inside it, so a test
    // runner discovering files in the repository never finds them.
    await Promise.all(['work', 'home', 'tmp'].map((d) => mkdir(join(root, d))));
    return new Sandbox(root, join(root, 'work'), revision, opts);
  }

  /** Resolve a repo-relative path, refusing anything that escapes the sandbox. */
  private safePath(path: string): string {
    const target = resolve(this.dir, normalize(path));
    const rel = relative(this.dir, target);
    if (rel.startsWith('..') || rel.startsWith(`..${sep}`) || resolve(target) === resolve(this.dir)) {
      throw new SandboxPathError(path);
    }
    return target;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const target = this.safePath(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  /**
   * Write a patch, refusing it whole if any file is one a patch may not touch.
   *
   * Every file is checked before any is written, so a refused patch leaves the tree
   * as it was. Returns each path's prior content (null when it did not exist), so
   * the caller can restore the tree.
   */
  async writePatch(
    files: readonly { path: string; content: string }[],
    opts: { regressionTestPath?: string | null } = {},
  ): Promise<Map<string, string | null>> {
    const prior = new Map<string, string | null>();
    for (const file of files) {
      const before = await this.readFile(file.path);
      const reason = protectedPathReason(file.path, before, file.content, opts);
      if (reason) throw new ProtectedPathError(file.path, reason);
      if (!prior.has(file.path)) prior.set(file.path, before);
    }
    for (const file of files) await this.writeFile(file.path, file.content);
    return prior;
  }

  async readFile(path: string): Promise<string | null> {
    try {
      return await readFile(this.safePath(path), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Names in a repository directory, or [] when it does not exist. */
  async listDir(path: string): Promise<string[]> {
    try {
      return (await readdir(this.safePath(path), { withFileTypes: true })).map((d) => (d.isDirectory() ? `${d.name}/` : d.name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
      throw err;
    }
  }

  /**
   * Every file in the working copy, repository-relative. Installed dependencies and
   * git's own metadata are not the repository's files and are skipped.
   */
  async listFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      for (const entry of await readdir(rel ? join(this.dir, rel) : this.dir, { withFileTypes: true })) {
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRS.has(entry.name)) await walk(path);
        } else if (entry.isFile()) {
          out.push(path);
        }
      }
    };
    await walk('');
    return out.sort();
  }

  async deleteFile(path: string): Promise<void> {
    await rm(this.safePath(path), { force: true });
  }

  /**
   * Run a command inside the sandbox.
   *
   * Arguments are passed as an array and never through a shell, so a filename
   * containing shell metacharacters cannot become an injection.
   */
  async run(command: string, args: string[] = [], options: RunOptions = {}): Promise<CommandResult> {
    return this.runner.run({
      command,
      args,
      workDir: this.dir,
      homeDir: join(this.root, 'home'),
      tmpDir: join(this.root, 'tmp'),
      env: options.env ?? {},
      timeoutMs: options.timeoutMs ?? this.opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? this.opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT,
      ...(options.network ? { network: true } : {}),
    });
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
