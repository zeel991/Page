import type { ValidationEngine, ValidationRun } from './validation.js';

/**
 * Which tests passed and which failed, read from a runner's output.
 *
 * Needed so that a suite that was already red at the deployed revision does not
 * block every incident on that repository: the tests that were already failing (or
 * that fail only sometimes) are recorded before anything is changed, and excluded
 * from the gate by name. That is only safe when the names are known, so parsing is
 * strict: when the failures cannot all be accounted for, the result is `null` and
 * nothing is excluded.
 */

export interface TestResults {
  passed: string[];
  failed: string[];
}

const LINE_PATTERNS: { re: RegExp; outcome: 'passed' | 'failed' }[] = [
  // node:test spec reporter: "✖ name (1.2ms)", "✔ name (0.3ms)".
  { re: /^\s*✖\s+(.+?)\s+\([\d.]+m?s\)\s*$/, outcome: 'failed' },
  { re: /^\s*✔\s+(.+?)\s+\([\d.]+m?s\)\s*$/, outcome: 'passed' },
  // TAP (node --test-reporter=tap, and others).
  { re: /^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/, outcome: 'failed' },
  { re: /^\s*ok \d+ - (.+?)(?:\s+#.*)?$/, outcome: 'passed' },
  // vitest: "× file > name 3ms", "✓ file > name".
  { re: /^\s*[×✗]\s+(.+?)(?:\s+\d+m?s)?\s*$/, outcome: 'failed' },
  { re: /^\s*✓\s+(.+?)(?:\s+\d+m?s)?\s*$/, outcome: 'passed' },
  // jest: "✕ name (5 ms)".
  { re: /^\s*✕\s+(.+?)(?:\s+\(\d+ ms\))?\s*$/, outcome: 'failed' },
  // pytest, short summary ("FAILED path::name - reason") and verbose ("path::name FAILED").
  { re: /^(?:FAILED|ERROR)\s+(\S+::\S+)/, outcome: 'failed' },
  { re: /^(\S+::\S+)\s+(?:FAILED|ERROR)\b/, outcome: 'failed' },
  { re: /^PASSED\s+(\S+::\S+)/, outcome: 'passed' },
  { re: /^(\S+::\S+)\s+PASSED\b/, outcome: 'passed' },
];

/**
 * The tests named in a run's output, or null when the failures cannot all be named.
 *
 * `reportedFailures` is the runner's own count; fewer named failures than that means
 * some went unrecognised, and a partial list must not be used to excuse a red run.
 */
export function parseTestResults(output: string, reportedFailures: number | null, exitCode: number | null): TestResults | null {
  const passed = new Set<string>();
  const failed = new Set<string>();
  for (const line of output.split('\n')) {
    for (const { re, outcome } of LINE_PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      (outcome === 'failed' ? failed : passed).add(m[1]!.trim());
      break;
    }
  }
  for (const name of failed) passed.delete(name);
  if (reportedFailures !== null && failed.size < reportedFailures) return null;
  if (exitCode !== 0 && failed.size === 0) return null;
  return { passed: [...passed].sort(), failed: [...failed].sort() };
}

/** The suite at the deployed revision, run twice before anything is changed. */
export interface SuiteBaseline {
  command: string | null;
  runs: ValidationRun[];
  /** Every run passed. */
  passed: boolean;
  /** Failed in every run. */
  failing: string[];
  /** Failed in some runs and not others. */
  flaky: string[];
  /**
   * Every failing test in every run was named. When false, nothing can be excluded
   * by name, and a red baseline blocks as it always did.
   */
  known: boolean;
}

export const BASELINE_RUNS = 2;

export async function establishBaseline(validation: ValidationEngine, command: string | null, runs = BASELINE_RUNS): Promise<SuiteBaseline> {
  const done: ValidationRun[] = [];
  for (let i = 0; i < runs; i++) {
    const run = await validation.runCheck('test', command);
    done.push(run);
    if (run.skipped) break;
  }
  if (done.some((r) => r.skipped)) return { command, runs: done, passed: false, failing: [], flaky: [], known: false };

  const results = done.map((r) => (r.passed ? { passed: [], failed: [] } : parseTestResults(r.output, r.testsFailed, r.exitCode)));
  const known = results.every((r) => r !== null);
  const failedIn = new Map<string, number>();
  for (const r of results) for (const name of r?.failed ?? []) failedIn.set(name, (failedIn.get(name) ?? 0) + 1);
  const failing = [...failedIn].filter(([, n]) => n === done.length).map(([name]) => name).sort();
  const flaky = [...failedIn].filter(([, n]) => n < done.length).map(([name]) => name).sort();
  return { command, runs: done, passed: done.every((r) => r.passed), failing, flaky, known };
}

/** The tests excluded from the gate, or null when none can be excluded by name. */
export function excludedFromGate(baseline: SuiteBaseline | null): string[] | null {
  if (!baseline || baseline.passed) return [];
  return baseline.known ? [...baseline.failing, ...baseline.flaky] : null;
}

/**
 * Whether a red run is red only because of tests excluded from the gate. False when
 * it cannot be shown: unnamed failures are never excused.
 */
export function onlyExcludedFailures(run: ValidationRun, excluded: readonly string[] | null): boolean {
  if (run.passed) return true;
  if (run.skipped || run.timedOut || !excluded || excluded.length === 0) return false;
  const results = parseTestResults(run.output, run.testsFailed, run.exitCode);
  if (!results) return false;
  const allowed = new Set(excluded);
  return results.failed.length > 0 && results.failed.every((name) => allowed.has(name));
}
