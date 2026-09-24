import { describe, expect, it } from 'vitest';
import { WorkerConfigError, loadConfig } from '../src/config.ts';

const BASE = {
  PAGER_SERVICE: 'checkout-api',
  PAGER_REPOSITORY: 'acme/checkout-api',
  PAGER_HEALTH_URL: 'https://checkout.example.com/health',
  PAGER_SLACK_CHANNEL: '#incidents',
  DATADOG_API_KEY: 'k',
  DATADOG_APP_KEY: 'a',
  GITHUB_TOKEN: 'g',
  SLACK_BOT_TOKEN: 's',
  ANTHROPIC_API_KEY: 'x',
};

const load = (env: Record<string, string>) => () => loadConfig({ ...BASE, ...env });

describe('worker configuration', () => {
  it('accepts a complete configuration with defaults', () => {
    const config = loadConfig(BASE);
    expect(config.intervalSeconds).toBe(60);
    expect(config.autonomy).toBe('L3');
  });

  // NaN once made setTimeout fire immediately, hammering every provider.
  it.each(['abc', '0', '5', '1.5', '99999'])('refuses PAGER_INTERVAL_SECONDS=%s', (value) => {
    expect(load({ PAGER_INTERVAL_SECONDS: value })).toThrow(/PAGER_INTERVAL_SECONDS/);
  });

  it('refuses to send Datadog keys to a host that is not Datadog', () => {
    expect(load({ DATADOG_BASE_URL: 'https://evil.example.com' })).toThrow(/DATADOG_BASE_URL/);
    expect(load({ DATADOG_BASE_URL: 'http://api.datadoghq.com' })).toThrow(/DATADOG_BASE_URL/);
    expect(loadConfig({ ...BASE, DATADOG_BASE_URL: 'https://api.datadoghq.eu' }).datadog.baseUrl).toBe('https://api.datadoghq.eu');
  });

  it('refuses an autonomy level too low to report', () => {
    expect(load({ PAGER_AUTONOMY_LEVEL: 'L1' })).toThrow(/at least L2/);
  });

  it('refuses a merge button with no named approvers', () => {
    const err = (() => {
      try {
        loadConfig({ ...BASE, PAGER_ENABLE_MERGE_BUTTON: '1', SLACK_SIGNING_SECRET: 'sec' });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(WorkerConfigError);
    expect(String(err)).toMatch(/PAGER_SLACK_TEAM_ID/);
    expect(String(err)).toMatch(/PAGER_MERGE_APPROVERS/);
  });

  it('reads merge approvers', () => {
    const config = loadConfig({
      ...BASE,
      PAGER_ENABLE_MERGE_BUTTON: '1',
      SLACK_SIGNING_SECRET: 'sec',
      PAGER_SLACK_TEAM_ID: 'T1',
      PAGER_MERGE_APPROVERS: 'U1, U2',
    });
    expect(config.mergeApprovers).toEqual({ teamId: 'T1', userIds: ['U1', 'U2'], channelId: null });
  });
});
