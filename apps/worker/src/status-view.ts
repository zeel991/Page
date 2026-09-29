import { redactSecrets } from '@pager/core';

/**
 * What the unauthenticated status page may show.
 *
 * `/` and `/status` are served on every interface, because the host's router and
 * Slack must reach the same port. Until the console has sign-in, anyone with the URL
 * can read them — so by default a remote reader gets a view with the people and the
 * raw vendor errors taken out: who approved a merge, and error text that can carry
 * request URLs and response bodies. The full record is served to a loopback caller,
 * or to everyone when the operator sets PAGER_PUBLIC_STATUS=1.
 *
 * Credentials are redacted in every view, full or not.
 */

export const WITHHELD = 'withheld (set PAGER_PUBLIC_STATUS=1, or read from localhost)';

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

/**
 * The status for this reader. A proxy in front of the worker makes every request
 * look non-loopback, which is the safe direction: X-Forwarded-For is not trusted.
 */
export function statusFor<T extends object>(status: T, opts: { remoteAddress: string | undefined; publicStatus: boolean }): T {
  const full = opts.publicStatus || isLoopback(opts.remoteAddress);
  const view = full ? status : strip(status);
  return JSON.parse(redactSecrets(JSON.stringify(view))) as T;
}

/** Error-bearing text: kept only as far as the first colon, which names the kind of outcome. */
function headline(text: unknown): unknown {
  if (typeof text !== 'string') return text;
  const at = text.indexOf(':');
  return at === -1 ? text : `${text.slice(0, at)}: ${WITHHELD}`;
}

function strip<T extends object>(status: T): T {
  const s = structuredClone(status) as Record<string, unknown>;
  if (Array.isArray(s.approvals)) {
    s.approvals = (s.approvals as Record<string, unknown>[]).map((a) => ({
      ...a,
      approvedBy: WITHHELD,
      outcome: headline(a.outcome),
    }));
  }
  if (typeof s.lastOutcome === 'string' && /failed|error|could not/i.test(s.lastOutcome)) {
    s.lastOutcome = headline(s.lastOutcome);
  }
  return s as T;
}
