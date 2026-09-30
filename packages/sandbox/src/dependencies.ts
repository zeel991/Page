import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandResult } from './runner.js';
import type { RepositoryProfile } from './repository-profile.js';
import type { Sandbox } from './sandbox.js';

/**
 * Installing a repository's dependencies before its tests run.
 *
 * Only from a lockfile, and only frozen: an install that resolves versions afresh
 * tests code nobody deployed, and may run code nobody reviewed. Lifecycle scripts
 * are never run (`--ignore-scripts`) — an install script is arbitrary code from the
 * dependency tree. The install is the one sandbox step that gets network access;
 * the suite then runs in a separate step without it.
 *
 * The installed tree is cached by the lockfile's hash, so the second incident on an
 * unchanged lockfile does not download anything.
 */

export interface InstallPlan {
  manager: string;
  /** The lockfile the install is frozen to. */
  lockfile: string;
  command: string;
  args: string[];
  /** Directories the install produces, relative to the repository root. Cached whole. */
  outputs: string[];
}

export type InstallStatus =
  /** Dependencies installed from the lockfile. */
  | 'installed'
  /** Restored from the cache for this exact lockfile. */
  | 'cached'
  /** Nothing to install: the manifest declares no dependencies. */
  | 'none'
  /** Dependencies are declared but there is no lockfile to freeze to; not installed. */
  | 'unpinned'
  /** The install ran and failed. */
  | 'failed';

export interface InstallResult {
  status: InstallStatus;
  plan: InstallPlan | null;
  cacheKey: string | null;
  detail: string;
  result: CommandResult | null;
}

/** Where installed trees are kept between sandboxes. */
export interface DependencyCache {
  restore(key: string, sandbox: Sandbox, outputs: readonly string[]): Promise<boolean>;
  save(key: string, sandbox: Sandbox, outputs: readonly string[]): Promise<void>;
}

/** A cache on the local filesystem: one directory per key, written atomically. */
export class DirectoryDependencyCache implements DependencyCache {
  constructor(private readonly root: string) {}

  async restore(key: string, sandbox: Sandbox, outputs: readonly string[]): Promise<boolean> {
    const entry = join(this.root, key);
    if (!(await exists(join(entry, '.complete')))) return false;
    for (const out of outputs) {
      if (await exists(join(entry, out))) {
        await cp(join(entry, out), join(sandbox.dir, out), { recursive: true, verbatimSymlinks: true });
      }
    }
    return true;
  }

  async save(key: string, sandbox: Sandbox, outputs: readonly string[]): Promise<void> {
    const entry = join(this.root, key);
    if (await exists(join(entry, '.complete'))) return;
    await mkdir(this.root, { recursive: true });
    // Written beside the entry and renamed into place, so a concurrent reader never
    // restores half an install.
    const staging = join(this.root, `.staging-${key}-${randomBytes(4).toString('hex')}`);
    await mkdir(staging, { recursive: true });
    try {
      for (const out of outputs) {
        if (await exists(join(sandbox.dir, out))) {
          await cp(join(sandbox.dir, out), join(staging, out), { recursive: true, verbatimSymlinks: true });
        }
      }
      await mkdir(join(staging, '.complete'));
      await rename(staging, entry).catch(async (err: NodeJS.ErrnoException) => {
        // Another sandbox finished the same key first; theirs is as good as ours.
        if (err.code !== 'ENOTEMPTY' && err.code !== 'EEXIST') throw err;
      });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

const NODE_LOCKFILES: readonly { file: string; manager: string; command: string; args: string[] }[] = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm', command: 'pnpm', args: ['install', '--frozen-lockfile', '--ignore-scripts'] },
  { file: 'yarn.lock', manager: 'yarn', command: 'yarn', args: ['install', '--frozen-lockfile', '--ignore-scripts'] },
  { file: 'bun.lock', manager: 'bun', command: 'bun', args: ['install', '--frozen-lockfile', '--ignore-scripts'] },
  { file: 'bun.lockb', manager: 'bun', command: 'bun', args: ['install', '--frozen-lockfile', '--ignore-scripts'] },
  // npm's frozen install is `ci`: it refuses a lockfile that disagrees with package.json.
  { file: 'package-lock.json', manager: 'npm', command: 'npm', args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'] },
];

/**
 * What would install this repository's dependencies, or why nothing can.
 *
 * Returns `{ plan: null }` with a reason when there is nothing to install or no
 * lockfile to freeze to.
 */
export async function planInstall(
  sandbox: Sandbox,
  profile: RepositoryProfile,
): Promise<{ plan: InstallPlan | null; status?: 'none' | 'unpinned'; reason: string }> {
  if (profile.language === 'python') return planPythonInstall(sandbox);

  const manifest = await sandbox.readFile('package.json');
  if (!manifest) return { plan: null, status: 'none', reason: 'no package manifest' };
  let pkg: { dependencies?: object; devDependencies?: object; optionalDependencies?: object };
  try {
    pkg = JSON.parse(manifest) as typeof pkg;
  } catch {
    return { plan: null, status: 'none', reason: 'package.json is not valid JSON' };
  }
  const declared = [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies].some((d) => d && Object.keys(d).length > 0);

  // The declared manager's lockfile first, then any lockfile present.
  const ordered = [...NODE_LOCKFILES].sort((a, b) => Number(b.manager === profile.packageManager) - Number(a.manager === profile.packageManager));
  for (const lock of ordered) {
    if (await exists(join(sandbox.dir, lock.file))) {
      return { plan: { manager: lock.manager, lockfile: lock.file, command: lock.command, args: lock.args, outputs: ['node_modules'] }, reason: '' };
    }
  }
  return declared
    ? {
        plan: null,
        status: 'unpinned',
        reason: 'package.json declares dependencies but there is no lockfile, so a frozen install is impossible. Not installed: resolving versions afresh would test code that was never deployed.',
      }
    : { plan: null, status: 'none', reason: 'package.json declares no dependencies' };
}

async function planPythonInstall(sandbox: Sandbox): Promise<{ plan: InstallPlan | null; status?: 'none' | 'unpinned'; reason: string }> {
  if (await exists(join(sandbox.dir, 'uv.lock'))) {
    return {
      plan: { manager: 'uv', lockfile: 'uv.lock', command: 'uv', args: ['sync', '--frozen', '--no-install-project'], outputs: ['.venv'] },
      reason: '',
    };
  }
  for (const file of ['requirements.lock', 'requirements.txt']) {
    const text = await sandbox.readFile(file);
    if (text === null) continue;
    const lines = text.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
    if (lines.length === 0) return { plan: null, status: 'none', reason: `${file} lists no packages` };
    // pip installs a requirements file as written; only exact pins make that frozen.
    const unpinned = lines.filter((l) => !l.startsWith('-') && !/==/.test(l));
    if (unpinned.length > 0) {
      return { plan: null, status: 'unpinned', reason: `${file} does not pin ${unpinned.slice(0, 3).join(', ')} with ==, so the install would not be frozen. Not installed.` };
    }
    return {
      plan: {
        manager: 'pip',
        lockfile: file,
        command: 'python3',
        // Into a virtualenv inside the repository, so the suite finds it and nothing
        // outside the sandbox changes. --no-deps: the file is the whole closure.
        args: ['-c', PIP_INSTALL, file],
        outputs: ['.venv'],
      },
      reason: '',
    };
  }
  return { plan: null, status: 'none', reason: 'no uv.lock or requirements file' };
}

/** Create .venv and install a fully pinned requirements file into it, running no build hooks it can avoid. */
const PIP_INSTALL =
  'import subprocess,sys,venv;venv.create(".venv",with_pip=True);' +
  'sys.exit(subprocess.call([".venv/bin/python","-m","pip","install","--no-deps","--only-binary=:all:",' +
  '"--disable-pip-version-check","-r",sys.argv[1]]))';

export interface InstallOptions {
  cache?: DependencyCache | null;
  timeoutMs?: number;
}

export async function installDependencies(sandbox: Sandbox, profile: RepositoryProfile, opts: InstallOptions = {}): Promise<InstallResult> {
  const { plan, status, reason } = await planInstall(sandbox, profile);
  if (!plan) return { status: status ?? 'none', plan: null, cacheKey: null, detail: reason, result: null };

  const lockBytes = (await sandbox.readFile(plan.lockfile)) ?? '';
  // Installed trees contain native binaries, so the platform and the runner (host
  // or container) are part of what makes two installs interchangeable.
  const cacheKey = createHash('sha256')
    .update([plan.manager, plan.command, ...plan.args, process.platform, process.arch, sandbox.runner.cacheScope ?? sandbox.runner.kind].join('\0'))
    .update('\0')
    .update(lockBytes)
    .digest('hex')
    .slice(0, 32);

  if (opts.cache && (await opts.cache.restore(cacheKey, sandbox, plan.outputs))) {
    return { status: 'cached', plan, cacheKey, detail: `restored from the cache for ${plan.lockfile} (${cacheKey})`, result: null };
  }

  const result = await sandbox.run(plan.command, plan.args, { network: true, timeoutMs: opts.timeoutMs ?? 600_000, maxOutputBytes: 200_000 });
  if (result.exitCode !== 0) {
    const why = result.exitCode === 127 ? `${plan.command} is not available in the sandbox` : result.timedOut ? 'the install timed out' : `exit ${result.exitCode}`;
    return {
      status: 'failed',
      plan,
      cacheKey,
      detail: `${plan.command} ${plan.args.join(' ')} failed (${why}): ${(result.stderr || result.stdout).trim().slice(-500)}`,
      result,
    };
  }
  await opts.cache?.save(cacheKey, sandbox, plan.outputs);
  return { status: 'installed', plan, cacheKey, detail: `installed from ${plan.lockfile} with ${plan.manager}`, result };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
