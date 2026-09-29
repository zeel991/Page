import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * GET a URL that a customer typed in, without letting it reach our own network.
 *
 * A health URL is tenant-supplied, so a naive fetch is a server-side request
 * forgery: point it at 169.254.169.254 or 10.x and the worker reads cloud
 * credentials or internal services on the attacker's behalf. So:
 *
 * - https only (http only when private addresses are explicitly allowed, for drills)
 * - the hostname is resolved and every address checked against private, loopback,
 *   link-local, CGNAT, multicast and metadata ranges — inside the connection's own
 *   lookup, so the address checked is the address connected to (no DNS rebinding)
 * - no redirects, a short timeout, and a small response cap
 * - errors are generic: the response body of a refused request is never echoed
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface SafeFetchOptions {
  /** Idle timeout: how long the socket may sit silent. */
  timeoutMs?: number;
  /**
   * Total timeout: how long the whole request may take. The idle timeout alone lets
   * a server trickle one byte every few seconds and hold the worker indefinitely.
   */
  totalTimeoutMs?: number;
  maxBytes?: number;
  /** Permit private addresses and plain http. For local drills only; never for tenants. */
  allowPrivate?: boolean;
  /** Injected in tests. */
  resolve?: (host: string) => Promise<string[]>;
}

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  // IPv4-compatible (::a.b.c.d, deprecated but still routed by some stacks) and 6to4
  // (2002:aabb:ccdd::) both embed an IPv4 address that could be private.
  ['::', 96],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
  ['2001:db8::', 32],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv6');
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6) {
    // An IPv4 address mapped into IPv6 is judged as the IPv4 address it is.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return BLOCKED.check(mapped[1]!, 'ipv4');
    return BLOCKED.check(address, 'ipv6');
  }
  return BLOCKED.check(address, 'ipv4');
}

const defaultResolve = (host: string): Promise<string[]> =>
  new Promise((resolve, reject) =>
    dnsLookup(host, { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs.map((a) => a.address)))),
  );

export async function safeGet(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError('not a valid URL');
  }
  const allowPrivate = opts.allowPrivate ?? false;
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw new UnsafeUrlError('only https URLs are allowed');
  }
  if (url.username || url.password) throw new UnsafeUrlError('URLs with credentials are not allowed');

  const resolve = opts.resolve ?? defaultResolve;
  const host = url.hostname.replace(/^\[|\]$/g, '');

  // Check before connecting (for a clear error), and again inside the socket's own
  // lookup, which is the address actually used.
  const addresses = isIP(host) ? [host] : await resolve(host);
  if (addresses.length === 0) throw new UnsafeUrlError('the host did not resolve');
  if (!allowPrivate && addresses.some(isBlockedAddress)) {
    throw new UnsafeUrlError('the host resolves to a private or reserved address');
  }

  const lookup: LookupFunction = (hostname, options, callback) => {
    resolve(hostname).then(
      (addrs) => {
        const usable = allowPrivate ? addrs : addrs.filter((a) => !isBlockedAddress(a));
        if (usable.length === 0 || (!allowPrivate && usable.length !== addrs.length)) {
          callback(new UnsafeUrlError('the host resolves to a private or reserved address'), '', 4);
          return;
        }
        const first = usable[0]!;
        if (options && (options as { all?: boolean }).all) {
          (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(
            null,
            usable.map((a) => ({ address: a, family: isIP(a) })),
          );
        } else {
          callback(null, first, isIP(first));
        }
      },
      (err: NodeJS.ErrnoException) => callback(err, '', 4),
    );
  };

  const timeoutMs = opts.timeoutMs ?? 5_000;
  const totalTimeoutMs = opts.totalTimeoutMs ?? Math.max(timeoutMs, 10_000);
  const maxBytes = opts.maxBytes ?? 64_000;
  const client = url.protocol === 'https:' ? https : http;

  return await new Promise<SafeResponse>((resolvePromise, reject) => {
    const req = client.get(
      url,
      { lookup: isIP(host) ? undefined : lookup, timeout: timeoutMs, headers: { accept: 'application/json' } },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new UnsafeUrlError(`response larger than ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error(`did not complete within ${totalTimeoutMs} ms`)), totalTimeoutMs);
    req.on('close', () => clearTimeout(deadline));
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', (err) => {
      clearTimeout(deadline);
      reject(err);
    });
  });
}
