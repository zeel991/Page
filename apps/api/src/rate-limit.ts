import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Per-caller request limits, in memory.
 *
 * A fixed window per key. In memory rather than in Postgres: a limit only has to
 * stop one caller from starving the others, and a restart forgiving everyone is
 * harmless. With several API instances each enforces its own window, so the
 * effective limit is the per-instance limit times the instances.
 *
 * Keys are chosen by what identifies a caller on each surface. Console routes are
 * keyed by the signed-in person, never by IP: every console request reaches the API
 * from the console's own servers, so an IP key would throttle every user together.
 * Webhooks are keyed by the sender's address.
 */
export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
}

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Milliseconds until the window resets. */
  resetMs: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly now: () => number;
  readonly opts: RateLimitOptions;

  constructor(opts: RateLimitOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  hit(key: string): RateDecision {
    const now = this.now();
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.opts.windowMs) {
      w = { start: now, count: 0 };
      this.windows.set(key, w);
      if (this.windows.size > 10_000) this.prune(now);
    }
    w.count += 1;
    return {
      allowed: w.count <= this.opts.limit,
      limit: this.opts.limit,
      remaining: Math.max(0, this.opts.limit - w.count),
      resetMs: w.start + this.opts.windowMs - now,
    };
  }

  /** Windows that have ended hold nothing worth keeping. */
  private prune(now: number): void {
    for (const [key, w] of this.windows) if (now - w.start >= this.opts.windowMs) this.windows.delete(key);
  }
}

/**
 * A Fastify hook enforcing `limiter` on the key `keyOf` gives. A null key is not
 * limited here (the route's own guard has already refused it).
 */
export function rateLimitHook(limiter: RateLimiter, keyOf: (request: FastifyRequest) => string | null) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const key = keyOf(request);
    if (key === null) return;
    const d = limiter.hit(key);
    void reply.header('x-ratelimit-limit', String(d.limit));
    void reply.header('x-ratelimit-remaining', String(d.remaining));
    if (!d.allowed) {
      await reply
        .code(429)
        .header('retry-after', String(Math.ceil(d.resetMs / 1000)))
        .send({ error: 'rate_limited', reason: `more than ${d.limit} requests in ${Math.round(limiter.opts.windowMs / 1000)}s; retry after the window resets` });
    }
  };
}
