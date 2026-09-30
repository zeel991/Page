/**
 * The statistics the benchmark reports. Small and explicit, so a reader can check
 * every number in the report against the trials it came from.
 */

export interface Proportion {
  successes: number;
  trials: number;
  /** successes / trials, or null when there were no trials. */
  rate: number | null;
  /** Wilson score interval at 95%, or null when there were no trials. */
  ci95: [number, number] | null;
}

/**
 * Wilson score interval. Unlike the normal approximation it stays inside [0, 1]
 * and is honest at small n and at rates of 0 or 1 — which is where a benchmark of
 * thirty-odd scenarios lives.
 */
export function wilson(successes: number, trials: number, z = 1.959964): Proportion {
  if (trials === 0) return { successes, trials, rate: null, ci95: null };
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denom;
  // At p = 0 or 1 the bound is exactly 0 or 1; rounding would otherwise leave 0.99999….
  const lower = successes === 0 ? 0 : Math.max(0, centre - half);
  const upper = successes === trials ? 1 : Math.min(1, centre + half);
  return { successes, trials, rate: p, ci95: [lower, upper] };
}

export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: the smallest value with at least q of the data at or below it.
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1]!;
}

export const median = (values: readonly number[]) => quantile(values, 0.5);

/**
 * pass@k over scenarios with exactly k trials each: the fraction of scenarios where
 * at least one of the k trials succeeded.
 */
export function passAtK(perScenario: readonly boolean[][]): Proportion {
  const withTrials = perScenario.filter((t) => t.length > 0);
  return wilson(withTrials.filter((t) => t.some(Boolean)).length, withTrials.length);
}

/**
 * Variance across trials: for each scenario, the variance of its 0/1 outcome over
 * its trials (p(1-p)); reported as the mean, and as how many scenarios did not give
 * the same outcome every time.
 */
export function trialVariance(perScenario: readonly boolean[][]): { meanVariance: number | null; inconsistentScenarios: number; scenarios: number } {
  const withTrials = perScenario.filter((t) => t.length > 0);
  if (withTrials.length === 0) return { meanVariance: null, inconsistentScenarios: 0, scenarios: 0 };
  const variances = withTrials.map((t) => {
    const p = t.filter(Boolean).length / t.length;
    return p * (1 - p);
  });
  return {
    meanVariance: variances.reduce((a, b) => a + b, 0) / variances.length,
    inconsistentScenarios: withTrials.filter((t) => t.some(Boolean) && !t.every(Boolean)).length,
    scenarios: withTrials.length,
  };
}
