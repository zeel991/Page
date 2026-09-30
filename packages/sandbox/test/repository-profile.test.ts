import { afterEach, describe, expect, it } from 'vitest';
import { Sandbox } from '../src/sandbox.js';
import { profileRepository, singleTestCommand } from '../src/repository-profile.js';
import { parseTestCounts } from '../src/validation.js';

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

describe('Python repositories', () => {
  it('profiles a pip project: pytest from its virtualenv, naming every result', async () => {
    sandbox = await Sandbox.fromFiles({ 'requirements.txt': 'pytest==8.3.3\n', 'billing/service.py': '' }, 'rev');
    const profile = await profileRepository(sandbox);
    expect(profile).toMatchObject({ language: 'python', packageManager: 'pip', testCommand: '.venv/bin/python -m pytest -rA -p no:cacheprovider' });
    expect(singleTestCommand(profile, 'tests/test_x.py')).toBe('.venv/bin/python -m pytest -rA -p no:cacheprovider tests/test_x.py');
  });

  it('reads pytest’s summary counts', () => {
    expect(parseTestCounts('...\n=========== 1 failed, 3 passed in 0.12s ===========\n')).toEqual({ passed: 3, failed: 1 });
    expect(parseTestCounts('=== 4 passed in 0.02s ===')).toEqual({ passed: 4, failed: 0 });
  });
});
