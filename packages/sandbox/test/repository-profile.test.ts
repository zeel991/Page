import { afterEach, describe, expect, it } from 'vitest';
import { Sandbox } from '../src/sandbox.js';
import { profileRepository } from '../src/repository-profile.js';

let sandbox: Sandbox | null = null;
afterEach(async () => {
  await sandbox?.dispose();
  sandbox = null;
});

const PKG = JSON.stringify({ name: 'svc', scripts: { test: 'node --test' } });

describe('repository profile on repositories that are not the demo', () => {
  it('detects CI from any GitHub Actions workflow, whatever it is named', async () => {
    sandbox = await Sandbox.fromFiles({ 'package.json': PKG, '.github/workflows/build-and-deploy.yaml': 'on: push\n' }, 'rev');
    expect((await profileRepository(sandbox)).hasCi).toBe(true);
  });

  it('reports no CI when there is no workflow', async () => {
    sandbox = await Sandbox.fromFiles({ 'package.json': PKG, '.github/CODEOWNERS': '* @acme' }, 'rev');
    expect((await profileRepository(sandbox)).hasCi).toBe(false);
  });

  it('lists the repository’s own files, not installed dependencies or git metadata', async () => {
    sandbox = await Sandbox.fromFiles(
      { 'package.json': PKG, 'src/a.ts': '', 'node_modules/x/index.js': '', '.venv/lib/y.py': '', 'test/a.test.ts': '' },
      'rev',
    );
    expect(await sandbox.listFiles()).toEqual(['package.json', 'src/a.ts', 'test/a.test.ts']);
  });
});
