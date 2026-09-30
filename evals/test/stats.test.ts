import { describe, expect, it } from 'vitest';
import { median, passAtK, quantile, trialVariance, wilson } from '../src/bench/stats.ts';

describe('benchmark statistics', () => {
  it('computes Wilson 95% intervals that match the published values', () => {
    // Reference values: Wilson score interval, z = 1.96.
    const half = wilson(5, 10);
    expect(half.rate).toBe(0.5);
    expect(half.ci95![0]).toBeCloseTo(0.2366, 3);
    expect(half.ci95![1]).toBeCloseTo(0.7634, 3);
    const none = wilson(0, 10);
    expect(none.ci95![0]).toBe(0);
    expect(none.ci95![1]).toBeCloseTo(0.2775, 3);
    const all = wilson(72, 72);
    expect(all.ci95![1]).toBe(1);
    expect(all.ci95![0]).toBeCloseTo(0.9493, 3);
    expect(wilson(0, 0)).toEqual({ successes: 0, trials: 0, rate: null, ci95: null });
  });

  it('takes nearest-rank quantiles', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(median([])).toBeNull();
  });

  it('counts pass@k and inconsistency per scenario', () => {
    expect(passAtK([[false, true, false], [false, false, false]]).successes).toBe(1);
    expect(trialVariance([[true, true, true], [true, false, true]])).toMatchObject({ inconsistentScenarios: 1, scenarios: 2 });
  });
});
