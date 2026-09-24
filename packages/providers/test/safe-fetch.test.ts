import { describe, expect, it } from 'vitest';
import { UnsafeUrlError, isBlockedAddress, safeGet } from '../src/safe-fetch.js';

/**
 * A tenant-supplied URL must not be able to reach our own network or cloud
 * metadata. These run without any network: every refusal happens before a socket.
 */
describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254',
  ])('blocks %s', (address) => expect(isBlockedAddress(address)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows %s', (address) =>
    expect(isBlockedAddress(address)).toBe(false),
  );
});

describe('safeGet', () => {
  const refuses = (url: string, resolveTo: string[] = ['93.184.216.34'], allowPrivate = false) =>
    expect(safeGet(url, { resolve: async () => resolveTo, allowPrivate })).rejects.toThrow(UnsafeUrlError);

  it('refuses plain http', () => refuses('http://example.com/health'));
  it('refuses a literal metadata address', () => refuses('https://169.254.169.254/latest/meta-data'));
  it('refuses a literal loopback address', () => refuses('https://127.0.0.1:4000/health'));
  it('refuses a hostname that resolves privately', () => refuses('https://internal.example.com/health', ['10.0.0.5']));
  // One public and one private answer is still refused: a rebinding attacker controls the order.
  it('refuses a hostname with any private address', () =>
    refuses('https://mixed.example.com/health', ['93.184.216.34', '127.0.0.1']));
  it('refuses credentials in the URL', () => refuses('https://user:pass@example.com/health'));
  it('refuses a malformed URL', () => refuses('not a url'));
});
