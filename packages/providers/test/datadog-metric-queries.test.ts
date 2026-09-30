import { describe, expect, it } from 'vitest';
import { DDTRACE_METRIC_QUERIES, DatadogProvider } from '../src/datadog/datadog-provider.js';

describe('Datadog metric queries', () => {
  const range = { from: new Date('2026-09-13T14:00:00Z'), to: new Date('2026-09-13T15:00:00Z') };
  const capture = () => {
    const sent: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      sent.push(new URL(String(url)).searchParams.get('query') ?? '');
      return new Response(JSON.stringify({ series: [{ metric: 'm', pointlist: [[Date.parse('2026-09-13T14:30:00Z'), 1]] }] }), { status: 200 });
    }) as typeof fetch;
    return { sent, fetchImpl };
  };

  it('uses ddtrace’s names by default', async () => {
    const { sent, fetchImpl } = capture();
    await new DatadogProvider({ baseUrl: 'https://dd.test', fetchImpl }).queryMetric('checkout-api', 'latency_p95', range);
    expect(sent).toEqual([DDTRACE_METRIC_QUERIES.latency_p95('checkout-api')]);
  });

  it('takes a service’s own query for a metric, instead of the domain knowing Datadog’s names', async () => {
    const { sent, fetchImpl } = capture();
    const dd = new DatadogProvider({
      baseUrl: 'https://dd.test',
      fetchImpl,
      metricQueries: { latency_p95: (s) => `p95:http.server.request.duration{service:${s}}` },
    });
    await dd.queryMetric('checkout-api', 'latency_p95', range);
    await dd.queryMetric('checkout-api', 'latency_p50', range);
    expect(sent).toEqual(['p95:http.server.request.duration{service:checkout-api}', DDTRACE_METRIC_QUERIES.latency_p50('checkout-api')]);
  });
});
