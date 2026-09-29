import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProtectedPathError, protectedPathReason, testCountRegression } from '../src/patch-policy.js';
import { Sandbox } from '../src/sandbox.js';

describe('protectedPathReason', () => {
  const pkg = (scripts: Record<string, string>, extra: object = {}) => JSON.stringify({ name: 'x', scripts, ...extra });

  it('allows application code, and a new test', () => {
    expect(protectedPathReason('src/checkout/service.ts', 'old', 'new')).toBeNull();
    expect(protectedPathReason('test/new-case.test.ts', null, 'it()')).toBeNull();
  });

  it.each([
    ['.github/workflows/ci.yml', 'x', /dotfile/],
    ['.env', null, /dotfile/],
    ['config/.npmrc', null, /dotfile/],
    ['pnpm-lock.yaml', 'x', /lockfile/],
    ['packages/a/package-lock.json', 'x', /lockfile/],
    ['vitest.config.ts', 'x', /runner configuration/],
    ['jest.config.js', null, /runner configuration/],
    ['conftest.py', null, /runner configuration/],
    ['Jenkinsfile', 'x', /CI configuration/],
    ['test/checkout.test.ts', 'x', /existing test/],
    ['src/__tests__/a.ts', 'x', /existing test/],
    ['tests/test_orders.py', 'x', /existing test/],
  ])('refuses %s', (path, before, reason) => {
    expect(protectedPathReason(path, before, 'y')).toMatch(reason);
  });

  it('refuses the regression test path, however it is spelled', () => {
    expect(protectedPathReason('./test//regression.test.ts', 'x', 'y', { regressionTestPath: 'test/regression.test.ts' })).toMatch(
      /regression test/,
    );
  });

  it('allows a package.json change that leaves scripts alone', () => {
    expect(protectedPathReason('package.json', pkg({ test: 'node --test' }), pkg({ test: 'node --test' }, { version: '2' }))).toBeNull();
  });

  it('refuses a package.json change to scripts or runner config', () => {
    expect(protectedPathReason('package.json', pkg({ test: 'node --test' }), pkg({ test: 'true' }))).toMatch(/"scripts"/);
    expect(protectedPathReason('package.json', pkg({}), pkg({}, { jest: { testPathIgnorePatterns: ['.'] } }))).toMatch(/"jest"/);
    expect(protectedPathReason('package.json', pkg({}), '{not json')).toMatch(/cannot be parsed/);
  });
});

describe('Sandbox.writePatch', () => {
  it('refuses the whole patch before writing any of it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pager-policy-'));
    try {
      const provider = {
        listFiles: async () => ['src/a.ts', 'test/a.test.ts'],
        getFile: async (_r: string, _s: string, path: string) => `// ${path}`,
      };
      const sandbox = await Sandbox.create(provider as never, 'a/b', 'sha', { rootDir: root });
      await expect(
        sandbox.writePatch([
          { path: 'src/a.ts', content: 'patched' },
          { path: 'test/a.test.ts', content: '' },
        ]),
      ).rejects.toBeInstanceOf(ProtectedPathError);
      // The permitted file was not written either.
      expect(await sandbox.readFile('src/a.ts')).toBe('// src/a.ts');
      const prior = await sandbox.writePatch([{ path: 'src/a.ts', content: 'patched' }, { path: 'src/new.ts', content: 'n' }]);
      expect(prior).toEqual(new Map([['src/a.ts', '// src/a.ts'], ['src/new.ts', null]]));
      await sandbox.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('testCountRegression', () => {
  it('accepts a suite that grew or held', () => {
    expect(testCountRegression({ passed: 5, failed: 0 }, { passed: 6, failed: 0 })).toBeNull();
    expect(testCountRegression({ passed: 4, failed: 1 }, { passed: 5, failed: 0 })).toBeNull();
  });

  it('refuses a suite that shrank', () => {
    expect(testCountRegression({ passed: 5, failed: 0 }, { passed: 3, failed: 0 })).toMatch(/5 test\(s\) before .* only 3/);
  });

  it('treats an unknown count as a failure, not a pass', () => {
    expect(testCountRegression({ passed: 5, failed: 0 }, { passed: null, failed: null })).toMatch(/could not be established after/);
    expect(testCountRegression({ passed: null, failed: 0 }, { passed: 5, failed: 0 })).toMatch(/could not be established before/);
  });
});
