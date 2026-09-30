import { describe, expect, it } from 'vitest';
import { DODO_BASE_URLS, DodoWebhookError, dodoFromEnv, signDodoWebhook, verifyDodoWebhook } from '../src/dodo/dodo-payments.js';

describe('Dodo webhooks (Standard Webhooks)', () => {
  // The Standard Webhooks specification's own example, so this is checked against
  // the scheme rather than against itself.
  const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const id = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
  const ts = 1614265330;
  const body = '{"test": 2432232314}';

  it('signs exactly as the specification’s example', () => {
    expect(signDodoWebhook(secret, id, ts, body)).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('accepts any matching entry among several, within five minutes', () => {
    const headers = { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': `v1,bm90LWl0 ${signDodoWebhook(secret, id, ts, body)}` };
    expect(verifyDodoWebhook(secret, headers, body, (ts + 299) * 1000).deliveryId).toBe(id);
    expect(() => verifyDodoWebhook(secret, headers, body, (ts + 301) * 1000)).toThrow(DodoWebhookError);
  });

  it('refuses a body changed after signing', () => {
    const headers = { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': signDodoWebhook(secret, id, ts, body) };
    expect(() => verifyDodoWebhook(secret, headers, '{"test": 1}', ts * 1000)).toThrow(/no signature matches/);
  });
});

describe('dodoFromEnv', () => {
  it('is off without a key and a webhook secret', () => {
    expect(dodoFromEnv({ DODO_PAYMENTS_API_KEY: 'k' })).toBeNull();
  });

  it('defaults to test mode, so a missing setting never takes real money', () => {
    const c = dodoFromEnv({ DODO_PAYMENTS_API_KEY: 'k', DODO_PAYMENTS_WEBHOOK_SECRET: 'whsec_eA==', DODO_PRODUCT_TEAM: 'pdt_1' })!;
    expect(c.mode).toBe('test_mode');
    expect(c.products).toEqual({ team: 'pdt_1' });
    expect(DODO_BASE_URLS[c.mode]).toBe('https://test.dodopayments.com');
    expect(() => dodoFromEnv({ DODO_PAYMENTS_API_KEY: 'k', DODO_PAYMENTS_WEBHOOK_SECRET: 's', DODO_PAYMENTS_ENVIRONMENT: 'live' })).toThrow(/live_mode/);
  });
});
