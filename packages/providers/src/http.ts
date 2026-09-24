/**
 * Minimal HTTP client shared by every provider adapter.
 *
 * Adapters are constructed with a base URL and headers resolved elsewhere (an Arga
 * twin endpoint, or a real vendor credential). Nothing here knows or cares which.
 */

export interface HttpOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  /**
   * Resolved per request, for credentials that expire — a GitHub App installation
   * token, for instance. Merged over the static headers.
   */
  dynamicHeaders?: () => Promise<Record<string, string>>;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Extra attempts for a rate-limited, unavailable or unreachable vendor. Default 3. */
  retries?: number;
  /** The longest single wait a retry may take. A longer required wait fails instead. */
  maxRetryWaitMs?: number;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** A request the vendor refused before doing anything, so repeating it cannot double an effect. */
function refusedUnprocessed(res: Response): boolean {
  if (res.status === 429) return true;
  // GitHub's secondary rate limit answers 403 with Retry-After.
  return res.status === 403 && res.headers.has('retry-after');
}

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);
const TRANSIENT = new Set([502, 503, 504]);

/**
 * How long the vendor asked us to wait, in ms, or null when it did not say.
 * Retry-After (seconds or a date); GitHub's x-ratelimit-reset (epoch seconds) when
 * the remaining budget is zero; Datadog's x-ratelimit-reset (seconds until reset).
 */
export function requestedWaitMs(headers: Headers, now = Date.now()): number | null {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    if (headers.get('x-ratelimit-remaining') === '0' && reset > 1_000_000_000) return Math.max(0, reset * 1000 - now);
    if (reset < 1_000_000_000) return reset * 1000;
  }
  return null;
}

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    readonly body: string,
  ) {
    super(`${method} ${url} failed with ${status}: ${truncate(body, 300)}`);
    this.name = 'ProviderHttpError';
  }

  /**
   * Arga returns 410 once a twin run's TTL has passed. Surfaced distinctly so
   * callers can re-provision rather than retry into a destroyed environment.
   */
  get isEnvironmentDestroyed(): boolean {
    return this.status === 410;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export class Http {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly dynamicHeaders: (() => Promise<Record<string, string>>) | null;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly maxRetryWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: HttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.headers = opts.headers ?? {};
    this.dynamicHeaders = opts.dynamicHeaders ?? null;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retries = Math.max(0, opts.retries ?? 3);
    this.maxRetryWaitMs = opts.maxRetryWaitMs ?? 30_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>('GET', this.url(path, query));
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', this.url(path), body);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', this.url(path), body);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', this.url(path), body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', this.url(path));
  }

  /** GET returning null on 404, for genuinely optional resources. */
  async getOptional<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T | null> {
    try {
      return await this.get<T>(path, query);
    } catch (err) {
      if (err instanceof ProviderHttpError && err.isNotFound) return null;
      throw err;
    }
  }

  private url(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  /**
   * One request, retried when retrying is safe.
   *
   * A request the vendor refused unprocessed (429, GitHub's secondary limit) is
   * retried whatever its method. A transient 502/503/504 or a network failure is
   * retried only for idempotent methods: a POST that may have landed is not sent
   * twice. Waits honour what the vendor asked for; a wait longer than the cap
   * fails now rather than stalling the incident for an hour.
   */
  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= this.retries;
      let res: Response;
      try {
        res = await this.once(method, url, body);
      } catch (err) {
        if (last || !IDEMPOTENT.has(method)) throw err;
        await this.sleep(backoff(attempt));
        continue;
      }
      if (res.ok) return await parse<T>(res);

      const retryable = refusedUnprocessed(res) || (IDEMPOTENT.has(method) && TRANSIENT.has(res.status));
      if (retryable && !last) {
        const wait = requestedWaitMs(res.headers) ?? backoff(attempt);
        if (wait <= this.maxRetryWaitMs) {
          await safeText(res);
          await this.sleep(wait);
          continue;
        }
      }
      throw new ProviderHttpError(res.status, method, url, await safeText(res));
    }
  }

  private async once(method: string, url: string, body?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const resolved = this.dynamicHeaders ? await this.dynamicHeaders() : {};
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...this.headers,
          ...resolved,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      // Read the body before the timer is cleared, so a stalled body still times out.
      const text = await safeText(res);
      return new Response(res.status === 204 || res.status === 304 ? null : text, {
        status: res.status,
        headers: res.headers,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** 250 ms, 1 s, 4 s … with jitter, so a fleet of workers does not retry in step. */
function backoff(attempt: number): number {
  const base = 250 * 4 ** attempt;
  return Math.round(base / 2 + Math.random() * base / 2);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '<unreadable body>';
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
