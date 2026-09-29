import type { MetricName, ObservabilityProvider, TimeRange } from '@pager/providers';
import type { AgentRunContext } from '@pager/observability';
import { mean } from './regression-detector.js';

/**
 * Recovery verification.
 *
 * A remediation being applied is not a recovery. This compares three windows —
 * baseline, incident, and post-remediation — and only reports recovery when the
 * signal has actually returned toward baseline.
 *
 * The asymmetry is deliberate: it is far worse to close an incident that is still
 * burning than to keep one open a little too long. So every ambiguous case resolves
 * to "not recovered".
 */

export interface MetricComparison {
  metric: MetricName;
  baseline: number;
  incident: number;
  postRemediation: number;
  recovered: boolean;
  /** How far back toward baseline the signal came, 0..1. Null when undefined. */
  recoveryFraction: number | null;
  reason: string;
}

/**
 * What the evidence actually supports.
 *
 * The three are genuinely different and were previously collapsed into one boolean,
 * which made the system say "signals have not returned to baseline" about a service
 * whose signals were never measured. That is a false statement about production, and
 * it is exactly the conflation this project exists to avoid: absent data is not
 * contrary data.
 *
 *  RECOVERED      — metrics were compared and came back toward baseline.
 *  NOT_RECOVERED  — metrics were compared and are still elevated. The incident burns.
 *  UNVERIFIABLE   — nothing could be compared. Says nothing either way.
 */
export type RecoveryVerdict = 'RECOVERED' | 'NOT_RECOVERED' | 'UNVERIFIABLE';

export interface RecoveryVerification {
  comparisons: MetricComparison[];
  monitorsRecovered: boolean | null;
  /** True only when every compared metric recovered and no monitor is still alerting. */
  recovered: boolean;
  verdict: RecoveryVerdict;
  /** Why the verdict is what it is, in one sentence a human can act on. */
  summary: string;
  /** Metrics that could not be compared. Their absence blocks a recovery claim. */
  unverified: { metric: MetricName; reason: string }[];
  /**
   * Requests served in the post-fix window, estimated from the request rate. Null
   * when it could not be measured — which blocks a recovery claim, because a
   * service nobody called has no errors and has proved nothing.
   */
  postFixRequests: number | null;
}

/**
 * How close to baseline a metric must return to count as recovered.
 *
 * Not 100%: production is noisy, and a baseline of 0.4% will not return to exactly
 * 0.4%. 85% of the excursion removed is a defensible "back to normal", and the
 * absolute-tolerance clause below handles metrics whose baseline is near zero.
 */
export const RECOVERY_THRESHOLD = 0.85;

/**
 * The fewest requests after the fix that can evidence a recovery.
 *
 * Below this, an error ratio is noise: 0 errors in 3 requests is not a recovery.
 */
export const MIN_POST_FIX_REQUESTS = 100;

export interface RecoveryOptions {
  threshold?: number;
  /** Minimum post-fix traffic. Fewer requests than this is UNVERIFIABLE. */
  minRequests?: number;
  /** Absolute difference from baseline that always counts as recovered. */
  absoluteTolerance?: Partial<Record<MetricName, number>>;
}

const DEFAULT_TOLERANCE: Partial<Record<MetricName, number>> = {
  // Ratios (failed ÷ all requests): half a percentage point.
  error_rate: 0.005,
  http_5xx_rate: 0.005,
  availability: 0.002,
  latency_p50: 20,
  latency_p95: 50,
  latency_p99: 100,
};

export function compareRecovery(
  metric: MetricName,
  baseline: number,
  incident: number,
  postRemediation: number,
  opts: RecoveryOptions = {},
): MetricComparison {
  const threshold = opts.threshold ?? RECOVERY_THRESHOLD;
  const tolerance = opts.absoluteTolerance?.[metric] ?? DEFAULT_TOLERANCE[metric];

  const excursion = incident - baseline;
  const remaining = postRemediation - baseline;

  // Within absolute tolerance of baseline is recovered regardless of ratios, which
  // matters when the baseline is near zero and fractions become meaningless.
  if (tolerance !== undefined && Math.abs(remaining) <= tolerance) {
    return {
      metric, baseline, incident, postRemediation,
      recovered: true,
      recoveryFraction: excursion === 0 ? null : 1 - remaining / excursion,
      reason: `Within ${tolerance} of baseline.`,
    };
  }

  if (excursion === 0) {
    return {
      metric, baseline, incident, postRemediation,
      recovered: false,
      recoveryFraction: null,
      // Nothing moved during the incident, so there is no excursion to recover from
      // and this metric cannot evidence a recovery either way.
      reason: 'Metric did not move during the incident; it cannot evidence recovery.',
    };
  }

  const fraction = 1 - remaining / excursion;
  const recovered = fraction >= threshold;
  return {
    metric, baseline, incident, postRemediation,
    recovered,
    recoveryFraction: Number(fraction.toFixed(3)),
    reason: recovered
      ? `Returned ${(fraction * 100).toFixed(0)}% of the way to baseline.`
      : `Only ${(fraction * 100).toFixed(0)}% of the excursion has cleared; ` +
        `${(threshold * 100).toFixed(0)}% is required.`,
  };
}

export interface RecoveryInput {
  service: string;
  metrics: MetricName[];
  baselineWindow: TimeRange;
  incidentWindow: TimeRange;
  postRemediationWindow: TimeRange;
}

/**
 * The verdict when no window of post-fix traffic exists to measure.
 *
 * Nothing was queried, so nothing is compared and no monitor is consulted: the
 * reason is the whole of what is known.
 */
export function unmeasuredRecovery(summary: string): RecoveryVerification {
  return {
    comparisons: [],
    monitorsRecovered: null,
    recovered: false,
    verdict: 'UNVERIFIABLE',
    summary,
    unverified: [],
    postFixRequests: null,
  };
}

export class RecoveryVerifier {
  constructor(private readonly observability: ObservabilityProvider) {}

  private async checkMonitors(ctx: AgentRunContext, service: string): Promise<boolean | null> {
    try {
      const res = await ctx.tool('datadog.listMonitors', { service }, () =>
        this.observability.listMonitors(service),
      );
      return res.value.every((m) => m.status === 'OK' || m.status === 'NO_DATA');
    } catch {
      return null;
    }
  }

  async verify(
    ctx: AgentRunContext,
    input: RecoveryInput,
    opts: RecoveryOptions = {},
  ): Promise<RecoveryVerification> {
    const comparisons: MetricComparison[] = [];
    const unverified: { metric: MetricName; reason: string }[] = [];

    for (const metric of input.metrics) {
      try {
        const windows = await Promise.all(
          (['baseline', 'incident', 'post'] as const).map(async (label, i) => {
            const range = [input.baselineWindow, input.incidentWindow, input.postRemediationWindow][i]!;
            const res = await ctx.tool(
              'datadog.queryMetric',
              { service: input.service, metric, window: label },
              () => this.observability.queryMetric(input.service, metric, range),
            );
            return res.value;
          }),
        );

        const [baseline, incident, post] = windows;
        if (!baseline?.points.length || !incident?.points.length || !post?.points.length) {
          unverified.push({
            metric,
            reason: 'One or more windows returned no data, so recovery cannot be established.',
          });
          continue;
        }

        comparisons.push(
          compareRecovery(
            metric,
            mean(baseline.points.map((p) => p.value)),
            mean(incident.points.map((p) => p.value)),
            mean(post.points.map((p) => p.value)),
            opts,
          ),
        );
      } catch (err) {
        unverified.push({ metric, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    const postFixRequests = await this.countRequests(ctx, input);

    // Monitors are a second, independent signal. A metric that looks recovered while
    // a monitor still alerts is not a recovery. Null means we could not tell, which
    // is treated as neither confirmation nor contradiction below.
    const monitorsRecovered = await this.checkMonitors(ctx, input.service);

    const everyMetricRecovered =
      comparisons.length > 0 && comparisons.every((c) => c.recovered);
    // Unverified metrics block the claim. Absence of evidence is not recovery.
    const recovered =
      everyMetricRecovered && unverified.length === 0 && monitorsRecovered !== false;

    const decided = decide({
      comparisons,
      unverified,
      monitorsRecovered,
      everyMetricRecovered,
      recovered,
    });

    // Too little traffic evidences nothing, so it vetoes a recovery claim: no
    // errors from no requests must never read as recovered. (A ratio still
    // elevated is left as it is — it came from requests that really failed, and
    // both outcomes keep the incident open.)
    const minRequests = opts.minRequests ?? MIN_POST_FIX_REQUESTS;
    if (decided.verdict === 'RECOVERED' && (postFixRequests === null || postFixRequests < minRequests)) {
      return {
        comparisons,
        monitorsRecovered,
        recovered: false,
        verdict: 'UNVERIFIABLE',
        summary:
          postFixRequests === null
            ? 'Recovery could not be verified: the error signals settled, but traffic after the fix could not ' +
              'be measured, so an absence of errors cannot be told apart from an absence of requests.'
            : `Recovery could not be verified: only about ${postFixRequests} request(s) were served after the ` +
              `fix, and at least ${minRequests} are needed before an error ratio means anything.`,
        unverified,
        postFixRequests,
      };
    }
    const { verdict, summary } = decided;

    return { comparisons, monitorsRecovered, recovered, verdict, summary, unverified, postFixRequests };
  }

  /**
   * Requests served in the post-fix window.
   *
   * Estimated from the request rate: each point's rate times the sampling step.
   * Null when there is no rate data, which is unknown, not zero.
   */
  private async countRequests(ctx: AgentRunContext, input: RecoveryInput): Promise<number | null> {
    try {
      const res = await ctx.tool(
        'datadog.queryMetric',
        { service: input.service, metric: 'request_throughput', window: 'post' },
        () => this.observability.queryMetric(input.service, 'request_throughput', input.postRemediationWindow),
      );
      const points = res.value.points;
      if (points.length === 0) return null;
      const windowMs = input.postRemediationWindow.to.getTime() - input.postRemediationWindow.from.getTime();
      const stepMs =
        points.length > 1
          ? (points.at(-1)!.at.getTime() - points[0]!.at.getTime()) / (points.length - 1)
          : windowMs;
      // Never credit more time than the window holds.
      const coveredSeconds = Math.min(windowMs, stepMs * points.length) / 1000;
      return Math.round(mean(points.map((p) => p.value)) * coveredSeconds);
    } catch {
      return null;
    }
  }
}

/**
 * Turn the measurements into a verdict and a sentence.
 *
 * The distinction that matters is between a signal that stayed bad and a signal
 * nobody could read. Both leave the incident open, but only the first is a
 * statement about production — and a human reading the second needs to know they
 * are looking at a gap in instrumentation, not at a fix that failed.
 *
 * A cleared monitor is real evidence even with no metrics behind it: the condition
 * that fired has stopped firing. It is reported as corroboration, never promoted to
 * a recovery on its own.
 */
function decide(input: {
  comparisons: MetricComparison[];
  unverified: { metric: MetricName; reason: string }[];
  monitorsRecovered: boolean | null;
  everyMetricRecovered: boolean;
  recovered: boolean;
}): { verdict: RecoveryVerdict; summary: string } {
  const { comparisons, unverified, monitorsRecovered, everyMetricRecovered, recovered } = input;

  if (recovered) {
    return {
      verdict: 'RECOVERED',
      summary:
        `All ${comparisons.length} compared metric(s) returned toward baseline` +
        (monitorsRecovered === true ? ' and no monitor is still alerting.' : '.'),
    };
  }

  // Nothing was measured at all. This says nothing about whether the fix worked.
  if (comparisons.length === 0) {
    const why = unverified[0]?.reason ?? 'no metric data was available';
    return {
      verdict: 'UNVERIFIABLE',
      summary:
        `Recovery could not be verified: no metric could be compared (${why}). ` +
        (monitorsRecovered === true
          ? 'The alerting monitor has cleared, which is corroborating but not sufficient on its own. '
          : monitorsRecovered === false
            ? 'A monitor is still alerting. '
            : '') +
        `This is a gap in instrumentation, not evidence that the fix failed.`,
    };
  }

  // Something was measured and it is still bad. This IS a statement about production.
  const stillBad = comparisons.filter((c) => !c.recovered).map((c) => c.metric);
  if (!everyMetricRecovered) {
    return {
      verdict: 'NOT_RECOVERED',
      summary: `Still elevated after the fix shipped: ${stillBad.join(', ')}.`,
    };
  }
  if (monitorsRecovered === false) {
    return { verdict: 'NOT_RECOVERED', summary: 'A monitor is still alerting despite the metrics settling.' };
  }
  return {
    verdict: 'UNVERIFIABLE',
    summary:
      `Some metrics recovered but ${unverified.length} could not be compared ` +
      `(${unverified.map((u) => u.metric).join(', ')}), so recovery is not established.`,
  };
}
