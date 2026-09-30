import type { LogEntries, MetricName, MetricSeries, MonitorState, ObservabilityProvider, TimeRange } from './types.js';

/** A metric that cannot be read because no backend for it is connected — never an empty series. */
export class MetricsUnavailableError extends Error {
  constructor(readonly what: string) {
    super(`No metrics backend is connected, so ${what} is unknown (not zero).`);
    this.name = 'MetricsUnavailableError';
  }
}

/**
 * The observability provider for a workspace that alerts through a backend with no
 * metrics of ours (Sentry) and has no metrics backend connected.
 *
 * Every read throws, so each consumer records the reading as unknown — a recovery
 * becomes UNVERIFIABLE, a telemetry snapshot is absent — rather than an empty
 * series being read as "nothing happened".
 */
export class UnavailableMetrics implements ObservabilityProvider {
  readonly kind = 'observability' as const;
  constructor(readonly backend: ObservabilityProvider['backend']) {}

  async queryMetric(service: string, metric: MetricName, _range: TimeRange): Promise<MetricSeries> {
    throw new MetricsUnavailableError(`${metric} for ${service}`);
  }

  async queryLogs(service: string): Promise<LogEntries> {
    throw new MetricsUnavailableError(`the logs of ${service}`);
  }

  async listMonitors(service: string): Promise<MonitorState[]> {
    throw new MetricsUnavailableError(`the monitors of ${service}`);
  }
}
