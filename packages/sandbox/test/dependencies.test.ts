import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Sandbox } from '../src/sandbox.js';
import { LocalProcessRunner, type RunSpec, type SandboxRunner } from '../src/runner.js';
import { profileRepository } from '../src/repository-profile.js';
import { DirectoryDependencyCache, installDependencies } from '../src/dependencies.js';

const run = promisify(execFile);

/** Records every command, and whether it was given the network. */
class RecordingRunner implements SandboxRunner {
  readonly kind = 'local-process' as const;
  readonly description = 'recording';
  readonly calls: RunSpec[] = [];
  private readonly inner = new LocalProcessRunner();
  run(spec: RunSpec) {
    this.calls.push(spec);
    return this.inner.run(spec);
  }
}

// A repository with one real dependency, resolved from a local directory so the test
// needs no registry. Its postinstall script would leave a marker if it ran.
const MANIFEST = JSON.stringify({ name: 'svc', version: '1.0.0', scripts: { test: 'node --test' }, dependencies: { tiny: 'file:./vendor/tiny' } }, null, 2);
const TINY = {
  'vendor/tiny/package.json': JSON.stringify({ name: 'tiny', version: '1.0.0', main: 'index.js', scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'/tmp/pager-postinstall-ran\', \'x\')"' } }),
  'vendor/tiny/index.js': 'module.exports = () => 42;\n',
};

let files: Record<string, string>;
const cleanup: string[] = [];

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pager-lock-'));
  cleanup.push(dir);
  await mkdir(join(dir, 'vendor/tiny'), { recursive: true });
  await writeFile(join(dir, 'package.json'), MANIFEST);
  for (const [p, c] of Object.entries(TINY)) await writeFile(join(dir, p), c);
  await run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir });
  files = { 'package.json': MANIFEST, ...TINY, 'package-lock.json': await readFile(join(dir, 'package-lock.json'), 'utf8') };
});

afterEach(async () => {
  while (cleanup.length > 1) await rm(cleanup.pop()!, { recursive: true, force: true });
});

async function sandboxWith(contents: Record<string, string>, runner: SandboxRunner) {
  const s = await Sandbox.fromFiles(contents, 'rev', { runner });
  cleanup.push(s.root);
  return s;
}

describe('installing dependencies', () => {
  it('installs from the lockfile, frozen, without lifecycle scripts, and gives only the install the network', async () => {
    await rm('/tmp/pager-postinstall-ran', { force: true });
    const runner = new RecordingRunner();
    const s = await sandboxWith(files, runner);
    const out = await installDependencies(s, await profileRepository(s));
    expect(out).toMatchObject({ status: 'installed', plan: { manager: 'npm', lockfile: 'package-lock.json' } });
    expect(runner.calls.map((c) => [c.command, ...c.args].join(' '))).toEqual(['npm ci --ignore-scripts --no-audit --no-fund']);
    expect(runner.calls[0]!.network).toBe(true);
    expect((await run('node', ['-e', 'console.log(require("tiny")())'], { cwd: s.dir })).stdout.trim()).toBe('42');
    await expect(stat('/tmp/pager-postinstall-ran')).rejects.toThrow();

    // The suite then runs without it.
    await s.run('node', ['--version']);
    expect(runner.calls[1]!.network).toBeUndefined();
  });

  it('restores an unchanged lockfile from the cache without installing again', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'pager-depcache-'));
    cleanup.push(cacheDir);
    const cache = new DirectoryDependencyCache(cacheDir);

    const first = await sandboxWith(files, new RecordingRunner());
    expect((await installDependencies(first, await profileRepository(first), { cache })).status).toBe('installed');

    const runner = new RecordingRunner();
    const second = await sandboxWith(files, runner);
    const out = await installDependencies(second, await profileRepository(second), { cache });
    expect(out.status).toBe('cached');
    expect(runner.calls).toEqual([]);
    expect((await run('node', ['-e', 'console.log(require("tiny")())'], { cwd: second.dir })).stdout.trim()).toBe('42');

    // A different lockfile is a different key.
    const changed = { ...files, 'package-lock.json': files['package-lock.json']!.replace('"version": "1.0.0"', '"version": "1.0.0" ') };
    const third = await sandboxWith(changed, new RecordingRunner());
    expect((await installDependencies(third, await profileRepository(third), { cache })).cacheKey).not.toBe(out.cacheKey);
  });

  it('refuses to install declared dependencies that no lockfile pins', async () => {
    const runner = new RecordingRunner();
    const { 'package-lock.json': _lock, ...unpinned } = files;
    const s = await sandboxWith(unpinned, runner);
    const out = await installDependencies(s, await profileRepository(s));
    expect(out.status).toBe('unpinned');
    expect(out.detail).toMatch(/no lockfile/);
    expect(runner.calls).toEqual([]);
  });

  it('installs nothing for a manifest with no dependencies', async () => {
    const runner = new RecordingRunner();
    const s = await sandboxWith({ 'package.json': JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }) }, runner);
    expect((await installDependencies(s, await profileRepository(s))).status).toBe('none');
    expect(runner.calls).toEqual([]);
  });
});
