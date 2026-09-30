import { afterEach, describe, expect, it } from 'vitest';
import { Sandbox } from '../src/sandbox.js';
import { ValidationEngine } from '../src/validation.js';
import { ReproductionAgent } from '../src/reproduction.js';
import { establishBaseline, excludedFromGate, onlyExcludedFailures, parseTestResults } from '../src/test-results.js';

describe('parseTestResults', () => {
  it('names passing and failing tests from node:test, TAP, vitest, jest and pytest', () => {
    const node = '✖ broken one (0.5ms)\n✔ fine (0.1ms)\nℹ fail 1\n\n✖ failing tests:\n\n✖ broken one (0.5ms)\n';
    expect(parseTestResults(node, 1, 1)).toEqual({ passed: ['fine'], failed: ['broken one'] });
    expect(parseTestResults('not ok 1 - a\nok 2 - b\n', 1, 1)).toEqual({ passed: ['b'], failed: ['a'] });
    expect(parseTestResults('  × cart > totals 3ms\n  ✓ cart > empties\n', 1, 1)).toEqual({ passed: ['cart > empties'], failed: ['cart > totals'] });
    expect(parseTestResults('  ✕ totals (5 ms)\n', 1, 1)).toEqual({ passed: [], failed: ['totals'] });
    expect(parseTestResults('FAILED tests/test_cart.py::test_total - AssertionError\nPASSED tests/test_cart.py::test_empty\n', 1, 1)).toEqual({
      passed: ['tests/test_cart.py::test_empty'],
      failed: ['tests/test_cart.py::test_total'],
    });
  });

  it('refuses to name failures it cannot all account for', () => {
    expect(parseTestResults('✖ one (1ms)\nℹ fail 2\n', 2, 1)).toBeNull();
    expect(parseTestResults('Segmentation fault', null, 139)).toBeNull();
  });
});

describe('the suite baseline', () => {
  let sandbox: Sandbox | null = null;
  afterEach(async () => {
    await sandbox?.dispose();
    sandbox = null;
  });

  const FILES = {
    'package.json': JSON.stringify({ name: 'x', type: 'module', scripts: { test: 'node --test' } }),
    'src/total.js': 'export const total = (xs) => xs.reduce((s, x) => s + x);\n',
    'test/legacy.test.js': "import { it } from 'node:test';\nimport assert from 'node:assert/strict';\nit('legacy importer', () => assert.equal(1, 2));\n",
    // Fails the first time it runs in this checkout, passes after: a flake.
    'test/flaky.test.js':
      "import { it } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { existsSync, writeFileSync } from 'node:fs';\n" +
      "it('eventually consistent', () => { const seen = existsSync('.ran'); writeFileSync('.ran', ''); assert.ok(seen); });\n",
    'test/ok.test.js': "import { it } from 'node:test';\nit('fine', () => {});\n",
  };

  it('runs twice, and tells a test that is broken from one that is flaky', async () => {
    sandbox = await Sandbox.fromFiles(FILES, 'rev');
    const b = await establishBaseline(new ValidationEngine(sandbox), 'node --test');
    expect(b).toMatchObject({ passed: false, known: true, failing: ['legacy importer'], flaky: ['eventually consistent'] });
    expect(b.runs).toHaveLength(2);
    expect(excludedFromGate(b)).toEqual(['legacy importer', 'eventually consistent']);
  });

  it('credits a new assertion in a red suite when the tests already failing are named', async () => {
    sandbox = await Sandbox.fromFiles(FILES, 'rev');
    const validation = new ValidationEngine(sandbox);
    const b = await establishBaseline(validation, 'node --test');
    const attempt = await new ReproductionAgent(sandbox, validation).demonstrateFailure({
      testPath: 'test/regression.test.js',
      testSource: "import { it } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/total.js';\nit('totals an empty basket as zero', () => assert.equal(total([]), 0));\n",
      command: 'node --test',
      expectedFailureMarkers: ['TypeError'],
      baseline: b.runs[0]!,
      excludedFailures: excludedFromGate(b),
    });
    expect(attempt.failureReason).toBeNull();
    expect(attempt.assertionEvidence.excludedFailures).toEqual(['legacy importer', 'eventually consistent']);

    // After a fix, a run red only in the excluded tests passes the gate; one that
    // fails anything else does not.
    await sandbox.writeFile('src/total.js', 'export const total = (xs) => xs.reduce((s, x) => s + x, 0);\n');
    expect((await new ReproductionAgent(sandbox, validation).confirmFix(attempt)).proven).toBe(true);
    const after = await validation.runCheck('test', 'node --test');
    expect(after.passed).toBe(false);
    expect(onlyExcludedFailures(after, excludedFromGate(b))).toBe(true);
    expect(onlyExcludedFailures(after, ['eventually consistent'])).toBe(false);
  });
});

describe('reproduction against a flaky test', () => {
  let sandbox: Sandbox | null = null;
  afterEach(async () => {
    await sandbox?.dispose();
    sandbox = null;
  });

  it('refuses a test that fails once and then passes against the same code', async () => {
    // Found by the benchmark: a timing-dependent test failed before the patch, passed
    // after it, and was credited as fail-before/pass-after.
    sandbox = await Sandbox.fromFiles({ 'package.json': JSON.stringify({ name: 'x', type: 'module', scripts: { test: 'node --test' } }) }, 'rev');
    const validation = new ValidationEngine(sandbox);
    const attempt = await new ReproductionAgent(sandbox, validation).demonstrateFailure({
      testPath: 'test/flaky.test.js',
      testSource:
        "import { it } from 'node:test';\nimport { existsSync, writeFileSync } from 'node:fs';\n" +
        "it('times out', () => { const warm = existsSync('.warm'); writeFileSync('.warm', ''); if (!warm) throw new Error('TimeoutError: slow'); });\n",
      command: 'node --test test/flaky.test.js',
      expectedFailureMarkers: ['TimeoutError'],
    });
    expect(attempt.failureReason).toMatch(/flaky/);
  });
});
