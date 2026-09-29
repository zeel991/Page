/**
 * Credential redaction for anything captured and shown: command output, error
 * messages, logs, the status page.
 *
 * Two layers, because neither is enough alone. Known token shapes are matched by
 * pattern, which catches a credential nobody told us about — a test printing
 * `process.env`, a vendor echoing a header. And every credential this process
 * actually holds is registered by value, which catches the ones with no
 * recognisable shape (a Datadog key is 32 hex characters, like a sha).
 */

const registered = new Set<string>();

/** Shorter than this, a value would redact ordinary words. Real credentials are longer. */
const MIN_SECRET_LENGTH = 8;

export const REDACTED = '[REDACTED]';

/** Remember a credential so it is redacted wherever it later appears. */
export function registerSecret(value: string | null | undefined): void {
  const v = value?.trim();
  if (!v || v.length < MIN_SECRET_LENGTH) return;
  registered.add(v);
  // The same credential as it appears inside a URL or a Basic auth header.
  const encoded = encodeURIComponent(v);
  if (encoded !== v) registered.add(encoded);
  registered.add(Buffer.from(`x-access-token:${v}`).toString('base64'));
}

const PATTERNS: [RegExp, string][] = [
  // Credentials in a URL's userinfo: https://user:token@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  // Authorization-style headers, however they are printed.
  [/\b(authorization|proxy-authorization|x-api-key|dd-api-key|dd-application-key|x-slack-signature)(\s*[:=]\s*"?)(?:(?:bearer|basic|token)\s+)?[^\s",]+/gi, `$1$2${REDACTED}`],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/g, `$1 ${REDACTED}`],
  // Vendor token shapes.
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bxapp-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, REDACTED],
  [/\bntn_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bsecret_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bre_[A-Za-z0-9_]{16,}\b/g, REDACTED],
  [/\blin_api_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\barga_[A-Za-z0-9_]{10,}\b/g, REDACTED],
  [/\blma_[A-Za-z0-9_]{10,}\b/g, REDACTED],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
];

/** The text with every recognised or registered credential replaced. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  // Longest first, so a secret that contains another is replaced whole.
  for (const secret of [...registered].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** The last four characters, for logs that must identify a credential without holding it. */
export function lastFour(secret: string): string {
  return secret.length <= 4 ? '****' : `…${secret.slice(-4)}`;
}
