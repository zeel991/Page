import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { SourceControlProvider } from '@pager/providers';
import { ProtectedPathError, protectedPathReason } from './patch-policy.js';
import { LocalProcessRunner, type CommandResult, type SandboxRunner } from './runner.js';

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
   * Materialise a repository at an exact revision.
   *
   * Files are fetched through the source control provider rather than cloned with
   * git, so the same path works against a twin and against real GitHub, and no
   * credential is ever written into a `.git/config` on disk.
   */
  static async create(
    provider: SourceControlProvider,
    repo: string,
    revision: string,
    opts: SandboxOptions = {},
  ): Promise<Sandbox> {
    const parent = opts.rootDir ?? tmpdir();
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, 'pager-sandbox-'));
    // Home and temp are siblings of the working copy, not inside it, so a test
    // runner discovering files in the repository never finds them.
    await Promise.all(['work', 'home', 'tmp'].map((d) => mkdir(join(root, d))));
    const sandbox = new Sandbox(root, join(root, 'work'), revision, opts);

    const listing = await provider.listFiles(repo, revision);
    if (listing.truncated) {
      // A sandbox missing files would test a tree that is not the failing one.
      throw new Error(
        `Cannot build a sandbox: the provider listed only part of ${repo}@${revision}. ` +
          `Refusing to run against an incomplete working copy.`,
      );
    }
    const paths = listing.paths;
    if (paths.length === 0) {
      throw new Error(
        `Cannot build a sandbox: ${repo}@${revision} reported no files. ` +
          `Refusing to run against an empty working copy.`,
      );
    }

    for (const path of paths) {
      const content = await provider.getFile(repo, revision, path);
      if (content === null) continue;
      await sandbox.writeFile(path, content);
    }
    return sandbox;
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
