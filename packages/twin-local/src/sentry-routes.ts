import { createHash } from 'node:crypto';
import type { Route, RouteContext, RouteResult } from './router.js';
import type { StoredLog, TwinState } from './store.js';

/**
 * A Sentry twin: the parts of `/api/0/` an alert source reads.
 *
 * Issues and events are derived from the scenario's error logs — the same ones the
 * Datadog twin serves — grouped the way Sentry groups them (one issue per error
 * type and message), with each log's stack parsed into the structured frames a
 * Sentry SDK would have sent. So one fixture can be triggered through either
 * backend, and the two agree about what happened.
 *
 * Faithful where it matters to a client: bearer auth, cursor pagination in the
 * `Link` header (`rel="next"; results="true"; cursor="…"`), `lastSeen:-60m` and
 * `start`/`end` filters, and 429 with Retry-After once a token's rate limit is
 * spent.
 */

interface TwinIssue {
  id: string;
  shortId: string;
  project: string;
  type: string | null;
  value: string;
  logs: StoredLog[];
}

const UNAUTHORIZED: RouteResult = { status: 401, body: { detail: 'Authentication credentials were not provided.' } };

/** Requests per token in the current window, on the wall clock (the scenario clock may stand still). */
const hits = new Map<string, { windowStart: number; count: number }>();

function guard(ctx: RouteContext): RouteResult | null {
  const token = /^Bearer\s+(.+)$/i.exec(ctx.headers.authorization ?? '')?.[1];
  if (!token) return UNAUTHORIZED;
  const { max, windowMs } = ctx.state.sentry.rateLimit;
  const now = Date.now();
  const h = hits.get(token);
  if (!h || now - h.windowStart >= windowMs) {
    hits.set(token, { windowStart: now, count: 1 });
    return null;
  }
  h.count++;
  if (h.count > max) {
    const wait = Math.max(1, Math.ceil((h.windowStart + windowMs - now) / 1000));
    return {
      status: 429,
      body: { detail: 'You are attempting to use this endpoint too frequently.' },
      headers: { 'retry-after': String(wait), 'x-sentry-rate-limit-remaining': '0', 'x-sentry-rate-limit-limit': String(max) },
    };
  }
  return null;
}

/** "TypeError: Cannot read …" → ["TypeError", "Cannot read …"]; the type from the stack when the message has none. */
function exceptionOf(log: StoredLog): { type: string | null; value: string } {
  const fromMessage = /^([A-Za-z_][\w.]*(?:Error|Exception)):\s*(.*)$/s.exec(log.message);
  if (fromMessage) return { type: fromMessage[1]!, value: fromMessage[2]! };
  const last = log.stack?.trim().split('\n').pop()?.trim() ?? '';
  const fromStack = /^([A-Za-z_][\w.]*(?:Error|Exception)):\s*(.*)$/.exec(last);
  return fromStack ? { type: fromStack[1]!, value: fromStack[2]! } : { type: null, value: log.message };
}

/** The frames a Sentry SDK would report for this stack: outermost first, with in-app set. */
export function sentryFrames(stack: string | null): { filename: string; absPath: string; lineNo: number; colNo: number | null; function: string | null; inApp: boolean }[] {
  if (!stack) return [];
  const out: ReturnType<typeof sentryFrames> = [];
  const python = [...stack.matchAll(/^\s*File "(.+?)", line (\d+)(?:, in (.+?))?\s*$/gm)];
  if (python.length) {
    for (const m of python) out.push(frame(m[1]!, Number(m[2]), null, m[3] ?? null));
    return out; // Python lists outermost first already.
  }
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    const withFn = /^at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/.exec(line);
    const bare = /^at\s+(.+?):(\d+):(\d+)$/.exec(line);
    if (withFn) out.push(frame(withFn[2]!, Number(withFn[3]), Number(withFn[4]), withFn[1]!));
    else if (bare) out.push(frame(bare[1]!, Number(bare[2]), Number(bare[3]), null));
  }
  return out.reverse(); // V8 lists innermost first; Sentry, outermost.
}

function frame(path: string, lineNo: number, colNo: number | null, fn: string | null) {
  const absPath = path.replace(/^file:\/\//, '');
  const inApp = !/node_modules\/|site-packages\/|dist-packages\/|node:internal|<frozen |\/lib\/python3/.test(absPath);
  return { filename: absPath.split('/').slice(-2).join('/'), absPath, lineNo, colNo, function: fn && fn !== '<module>' ? fn : null, inApp };
}

function issuesOf(state: TwinState, project: string): TwinIssue[] {
  const groups = new Map<string, TwinIssue>();
  for (const log of state.logs) {
    if (log.service !== project || (log.level !== 'error' && log.level !== 'fatal')) continue;
    const { type, value } = exceptionOf(log);
    const key = `${type ?? ''}|${value}`;
    let issue = groups.get(key);
    if (!issue) {
      const id = String(parseInt(createHash('sha1').update(`${project}|${key}`).digest('hex').slice(0, 8), 16));
      issue = { id, shortId: `${project.toUpperCase()}-${groups.size + 1}`, project, type, value, logs: [] };
      groups.set(key, issue);
    }
    issue.logs.push(log);
  }
  return [...groups.values()];
}

function findIssue(state: TwinState, id: string): TwinIssue | undefined {
  const projects = new Set(state.logs.map((l) => l.service));
  for (const p of projects) {
    const found = issuesOf(state, p).find((i) => i.id === id);
    if (found) return found;
  }
  return undefined;
}

function issueJson(issue: TwinIssue, now: number) {
  const first = Math.min(...issue.logs.map((l) => l.at));
  const last = Math.max(...issue.logs.map((l) => l.at));
  return {
    id: issue.id,
    shortId: issue.shortId,
    title: issue.type ? `${issue.type}: ${issue.value}` : issue.value,
    culprit: sentryFrames(issue.logs[0]!.stack).filter((f) => f.inApp).pop()?.function ?? null,
    permalink: `https://acme.sentry.io/issues/${issue.id}/`,
    status: 'unresolved',
    substatus: now - first <= 7 * 24 * 3600_000 ? 'new' : 'ongoing',
    firstSeen: new Date(first).toISOString(),
    lastSeen: new Date(last).toISOString(),
    count: String(issue.logs.length),
    metadata: { type: issue.type, value: issue.value },
    project: { slug: issue.project },
  };
}

function eventJson(issue: TwinIssue, log: StoredLog, index: number) {
  const route = typeof log.attributes['http.route'] === 'string' ? (log.attributes['http.route'] as string) : null;
  return {
    id: createHash('sha1').update(`${issue.id}|${log.at}|${index}`).digest('hex').slice(0, 32),
    dateCreated: new Date(log.at).toISOString(),
    title: issue.type ? `${issue.type}: ${issue.value}` : issue.value,
    message: log.message,
    tags: route ? [{ key: 'transaction', value: route }] : [],
    entries: [{ type: 'exception', data: { values: [{ type: issue.type, value: issue.value, stacktrace: { frames: sentryFrames(log.stack) } }] } }],
  };
}

/** A page of items, and the Link header that says whether there is another. */
function page<T>(ctx: RouteContext, path: string, items: T[], size: number): RouteResult {
  const offset = Number(/^\d+:(\d+):\d+$/.exec(ctx.query.cursor ?? '')?.[1] ?? 0);
  const slice = items.slice(offset, offset + size);
  const base = new URL(`http://twin${path}`);
  for (const [k, v] of Object.entries(ctx.query)) if (k !== 'cursor') base.searchParams.set(k, v);
  const link = (rel: string, at: number, results: boolean) => {
    const url = new URL(base);
    url.searchParams.set('cursor', `0:${at}:0`);
    return `<${url.pathname}${url.search}>; rel="${rel}"; results="${results}"; cursor="0:${at}:0"`;
  };
  return {
    status: 200,
    body: slice,
    headers: { link: [link('previous', Math.max(0, offset - size), offset > 0), link('next', offset + size, offset + size < items.length)].join(', ') },
  };
}

export function sentryRoutes(): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/api\/0\/organizations\/([^/]+)\/$/,
      handler: (ctx) => {
        const refused = guard(ctx);
        if (refused) return refused;
        if (ctx.params[0] !== ctx.state.sentry.organization) return { status: 404, body: { detail: 'The requested resource does not exist' } };
        return { status: 200, body: { slug: ctx.state.sentry.organization, name: 'Acme' } };
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/0\/projects\/([^/]+)\/([^/]+)\/issues\/$/,
      handler: (ctx) => {
        const refused = guard(ctx);
        if (refused) return refused;
        const [org, project] = ctx.params as [string, string];
        if (org !== ctx.state.sentry.organization || !ctx.state.logs.some((l) => l.service === project)) {
          return { status: 404, body: { detail: 'The requested resource does not exist' } };
        }
        const now = ctx.now();
        const since = /lastSeen:-(\d+)([mhd])/.exec(ctx.query.query ?? '');
        const minMs = since ? Number(since[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[since[2] as 'm' | 'h' | 'd'] : null;
        const issues = issuesOf(ctx.state, project)
          .map((i) => issueJson(i, now))
          .filter((i) => minMs === null || now - Date.parse(i.lastSeen) <= minMs)
          .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
        return page(ctx, `/sentry/api/0/projects/${org}/${project}/issues/`, issues, ctx.state.sentry.pageSize.issues);
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/0\/organizations\/([^/]+)\/issues\/([^/]+)\/events\/$/,
      handler: (ctx) => {
        const refused = guard(ctx);
        if (refused) return refused;
        const [org, id] = ctx.params as [string, string];
        const issue = org === ctx.state.sentry.organization ? findIssue(ctx.state, id) : undefined;
        if (!issue) return { status: 404, body: { detail: 'The requested resource does not exist' } };
        const from = ctx.query.start ? Date.parse(ctx.query.start) : -Infinity;
        const to = ctx.query.end ? Date.parse(ctx.query.end) : Infinity;
        const events = issue.logs
          .map((log, i) => ({ log, i }))
          .filter(({ log }) => log.at >= from && log.at <= to)
          .sort((a, b) => b.log.at - a.log.at)
          .map(({ log, i }) => eventJson(issue, log, i));
        return page(ctx, `/sentry/api/0/organizations/${org}/issues/${id}/events/`, events, ctx.state.sentry.pageSize.events);
      },
    },
  ];
}
