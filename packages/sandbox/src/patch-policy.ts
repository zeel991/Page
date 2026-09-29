/**
 * What a patch may not touch.
 *
 * A patch is judged by the checks that run after it is applied, so a patch that can
 * edit those checks can pass them by disabling them: delete a test, rewrite the
 * `test` script to `true`, relax the runner's config, pin a lockfile to something
 * else, or change CI. None of these is ever part of fixing a production bug, so they
 * are refused outright rather than weighed.
 *
 * Enforced where patch files are written to disk (`Sandbox.writePatchFile`), not
 * only in a generator, because a generator is replaceable and the disk is not.
 */

export class ProtectedPathError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`Patch rejected: it modifies ${path}, ${reason}. A patch may not change the checks that judge it.`);
    this.name = 'ProtectedPathError';
  }
}

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Cargo.lock',
  'Gemfile.lock',
  'go.sum',
]);

const CI_FILES = new Set(['Jenkinsfile', 'azure-pipelines.yml', 'bitbucket-pipelines.yml']);

/** Test-runner configuration, by basename. */
const RUNNER_CONFIG = [
  /^vitest\.(config|workspace)\.[cm]?[jt]s$/,
  /^vite\.config\.[cm]?[jt]s$/,
  /^jest\.config\.[cm]?[jt]s(on)?$/,
  /^playwright\.config\.[cm]?[jt]s$/,
  /^karma\.conf\.[cm]?js$/,
  /^ava\.config\.[cm]?js$/,
  /^pytest\.ini$/,
  /^tox\.ini$/,
  /^conftest\.py$/,
  /^noxfile\.py$/,
];

/** A test file, by the conventions the common runners discover. */
export function isTestFile(path: string): boolean {
  const parts = path.split('/');
  const base = parts.at(-1) ?? '';
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) ||
    /^test_.*\.py$/.test(base) ||
    /_test\.(py|go)$/.test(base) ||
    parts.slice(0, -1).some((d) => d === 'test' || d === 'tests' || d === '__tests__')
  );
}

export function normalisePatchPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+/g, '/');
}

/**
 * Why this path is off limits to a patch, or null when it may be written.
 *
 * `before` is the file's content in the deployed tree (null when absent), because
 * an existing test is protected while a new one is not, and `package.json` is
 * judged by whether its scripts changed.
 */
export function protectedPathReason(
  rawPath: string,
  before: string | null,
  after: string,
  opts: { regressionTestPath?: string | null } = {},
): string | null {
  const path = normalisePatchPath(rawPath);
  const parts = path.split('/');
  const base = parts.at(-1) ?? '';

  if (opts.regressionTestPath && path === normalisePatchPath(opts.regressionTestPath)) {
    return 'the regression test that demonstrates the failure';
  }
  // Covers .github/**, .gitlab-ci.yml, .circleci/**, .env, .npmrc, .mocharc and every
  // other dotfile or dot-directory: configuration, never application code.
  if (parts.some((p) => p.startsWith('.'))) return 'a dotfile or dot-directory (configuration, CI or credentials)';
  if (LOCKFILES.has(base)) return 'a dependency lockfile';
  if (CI_FILES.has(base)) return 'CI configuration';
  if (RUNNER_CONFIG.some((r) => r.test(base))) return 'test-runner configuration';
  if (before !== null && isTestFile(path)) return 'an existing test';
  if (base === 'package.json') {
    const changed = changedPackageFields(before, after);
    if (changed) return `package.json ${changed}`;
  }
  return null;
}

/** Which check-controlling fields of package.json changed, or null. */
function changedPackageFields(before: string | null, after: string): string | null {
  let prev: Record<string, unknown> = {};
  let next: Record<string, unknown>;
  try {
    if (before !== null) prev = JSON.parse(before) as Record<string, unknown>;
    next = JSON.parse(after) as Record<string, unknown>;
  } catch {
    return 'in a form that cannot be parsed, so its scripts cannot be shown unchanged';
  }
  for (const field of ['scripts', 'jest', 'vitest', 'ava', 'mocha']) {
    if (stable(prev[field]) !== stable(next[field])) return `"${field}"`;
  }
  return null;
}

function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(',')}}`;
}

/**
 * Did the patch shrink the suite?
 *
 * Returns why the counts refuse the patch, or null when they do not. An unknown
 * count is a refusal: "we could not tell how many tests ran" cannot establish that
 * none were removed.
 */
export function testCountRegression(
  before: { passed: number | null; failed: number | null },
  after: { passed: number | null; failed: number | null },
): string | null {
  const total = (c: { passed: number | null; failed: number | null }) =>
    c.passed === null || c.failed === null ? null : c.passed + c.failed;
  const b = total(before);
  const a = total(after);
  if (b === null || a === null) {
    return (
      `the number of tests the suite runs could not be established ${b === null ? 'before' : 'after'} the patch, ` +
      `so it cannot be shown that no test was removed or disabled`
    );
  }
  if (a < b) return `the suite ran ${b} test(s) before the patch and only ${a} after it`;
  return null;
}
