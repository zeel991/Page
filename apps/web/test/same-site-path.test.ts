import { describe, expect, it } from 'vitest';
import { sameSitePath } from '../src/lib/same-site-path';

describe('the sign-in return path', () => {
  it('keeps the page middleware sent the person from, which arrives as an absolute URL', () => {
    expect(sameSitePath('http://localhost:4500/incidents/abc?tab=evidence')).toBe('/incidents/abc?tab=evidence');
    expect(sameSitePath('/services#new')).toBe('/services#new');
  });

  it.each([
    ['another host', 'https://evil.example/steal'],
    ['a protocol-relative URL', '//evil.example/steal'],
    ['a doubled slash inside an absolute URL', 'http://localhost:4500//evil.example'],
    ['a backslash trick', '/\\evil.example'],
  ])('never leaves the site for %s', (_label, input) => {
    const path = sameSitePath(input);
    if (path !== null) {
      expect(path).toMatch(/^\/[^/\\]/);
      expect(new URL(path, 'http://console.test').host).toBe('console.test');
    }
  });

  it('falls back when there is nothing worth returning to', () => {
    expect(sameSitePath(undefined)).toBeNull();
    expect(sameSitePath('http://localhost:4500/')).toBeNull();
    expect(sameSitePath('/signin?callbackUrl=/x')).toBeNull();
  });
});
