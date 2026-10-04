import { createHmac, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { clean, githubAppFromEnv } from '../src/github/app-env.js';

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const base = {
  GITHUB_APP_ID: '5178636',
  GITHUB_APP_PRIVATE_KEY: pem,
  GITHUB_APP_SLUG: 'pager',
  GITHUB_APP_CLIENT_ID: 'Iv23abc',
  GITHUB_APP_CLIENT_SECRET: 'client-secret',
  GITHUB_APP_WEBHOOK_SECRET: 'whsec-123',
};
const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('githubAppFromEnv', () => {
  // A webhook secret pasted with a trailing newline, or imported from a .env file with
  // its quotes, verified no delivery GitHub signed: every webhook got 401.
  it.each([
    ['a trailing newline', 'whsec-123\n'],
    ['surrounding spaces', '  whsec-123 '],
    ['double quotes', '"whsec-123"'],
    ['single quotes', "'whsec-123'"],
  ])('verifies GitHub’s signature when the secret was stored with %s', (_case, stored) => {
    const app = githubAppFromEnv({ ...base, GITHUB_APP_WEBHOOK_SECRET: stored })!;
    const body = '{"zen":"ok"}';
    expect(app.verifyWebhook(body, sign('whsec-123', body))).toBe(true);
    expect(app.verifyWebhook(body, sign('another', body))).toBe(false);
  });

  it('reads a quoted, \\n-escaped private key as its PEM', () => {
    const escaped = `"${pem.trim().replace(/\n/g, '\\n')}"`;
    expect(() => githubAppFromEnv({ ...base, GITHUB_APP_PRIVATE_KEY: escaped })).not.toThrow();
  });

  it('cleans only the outside of a value', () => {
    expect(clean(' "a b" ')).toBe('a b');
    expect(clean('a"b')).toBe('a"b');
  });
});
