import { describe, expect, it } from 'vitest';
import { REDACTED, lastFour, redactSecrets, registerSecret } from '../src/redact.js';

describe('redactSecrets', () => {
  it.each([
    ['a GitHub installation token', 'token ghs_abcdefghijklmnopqrstuvwxyz0123'],
    ['a fine-grained PAT', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop'],
    ['a Slack bot token', ['xoxb', '1234567890', '0987654321', 'abcdefghijklmnop'].join('-')],
    ['an Anthropic key', 'sk-ant-api03-abcdefghijklmnop'],
    ['credentials in a URL', 'fatal: https://x-access-token:s3cr3tvalue@github.com/a/b.git not found'],
    ['an authorization header', 'Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig'],
    ['a Datadog key header', 'dd-api-key: 0123456789abcdef0123456789abcdef'],
  ])('removes %s', (_label, text) => {
    const out = redactSecrets(text);
    expect(out).toContain(REDACTED);
    expect(out).not.toMatch(/ghs_abc|github_pat_11|xoxb-12|sk-ant-api03|s3cr3tvalue|eyJhbGci|0123456789abcdef0123/);
  });

  it('removes a registered credential that has no recognisable shape', () => {
    // A Datadog application key is just hex; only its value identifies it.
    const key = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
    registerSecret(key);
    expect(redactSecrets(`query failed with key=${key}`)).toBe(`query failed with key=${REDACTED}`);
  });

  it('leaves ordinary text and commit shas alone', () => {
    const text = 'Production is running 3f2a9c1d0e8b7a6f5e4d3c2b1a0f9e8d7c6b5a49 on checkout-api';
    expect(redactSecrets(text)).toBe(text);
  });

  it('ignores values too short to be credentials', () => {
    registerSecret('abc');
    expect(redactSecrets('abc def')).toBe('abc def');
  });

  it('identifies a credential by its last four characters only', () => {
    expect(lastFour('xoxb-secret-1234')).toBe('…1234');
  });
});
