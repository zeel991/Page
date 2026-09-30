import { Http } from '../http.js';
import type { AlertSource, MonitorState, ObservedErrorGroup, ObservedErrors, ObservedFrame, TimeRange } from '../types.js';

/**
 * Sentry as an alert source.
 *
 * Written against Sentry's REST API (`/api/0/…`), so the same class serves the local
 * twin and sentry.io (or a self-hosted Sentry, or a regional host). A service is a
 * Sentry project, named by its slug.
 *
 * What Sentry gives that a log line does not: its SDKs have already parsed the
 * exception into typed frames, with an in-app flag. Those are passed through as
 * they are — no stack text is re-parsed with a regular expression.
 *
 * Pagination follows the `Link` header's `rel="next"` cursor while it says
 * `results="true"`; a read that stops at its cap with more available says so
 * (`truncated`), so counts are lower bounds rather than totals. Rate limits (429,
 * Retry-After) are handled by the shared client.
 */

export interface SentryProviderOptions {
  /** https://sentry.io, a regional host (https://us.sentry.io), or a self-hosted base URL. */
  baseUrl: string;
  /** An auth token with event:read and project:read. */
  token: string;
  /** The organization slug. */
  organization: string;
  /** Only events from this environment, when set. */
  environment?: string;
  /** Issues first seen this recently count as alerting even without a new/regressed substatus. */
  newWithinMinutes?: number;
  /** Issues are "active" when last seen within this window. */
  activeWithinMinutes?: number;
  /** Upper bounds on a single read. */
  maxIssues?: number;
  maxEventsPerIssue?: number;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
}

interface SentryIssue {
  id: string;
  shortId?: string;
  title: string;
  culprit?: string;
  permalink?: string;
  status: string;
  substatus?: string | null;
  firstSeen: string;
  lastSeen: string;
  count?: string | number;
  metadata?: { type?: string; value?: string };
}

interface SentryFrame {
  filename?: string | null;
  absPath?: string | null;
  lineNo?: number | null;
  colNo?: number | null;
  function?: string | null;
  inApp?: boolean | null;
}

interface SentryEvent {
  id: string;
  eventID?: string;
  dateCreated: string;
  title?: string;
  message?: string;
  tags?: { key: string; value: string }[];
  entries?: (
    | { type: 'exception'; data: { values?: { type?: string | null; value?: string | null; stacktrace?: { frames?: SentryFrame[] } | null }[] } }
    | { type: 'request'; data: { url?: string; method?: string } }
    | { type: string; data: unknown }
  )[];
}

/** Statuses Sentry gives an issue that is behaving differently from before. */
const ALERTING_SUBSTATUS = new Set(['new', 'regressed', 'escalating']);

export class SentryProvider implements AlertSource {
  readonly backend = 'sentry' as const;
  readonly alertNoun = 'Sentry issue';
  private readonly http: Http;
  private readonly org: string;
  private readonly environment: string | null;
  private readonly newWithinMs: number;
  private readonly activeWithinMinutes: number;
  private readonly maxIssues: number;
  private readonly maxEvents: number;
  private readonly now: () => Date;

  constructor(opts: SentryProviderOptions) {
    this.http = new Http({
      baseUrl: opts.baseUrl,
      headers: { authorization: `Bearer ${opts.token}` },
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    this.org = opts.organization;
    this.environment = opts.environment ?? null;
    this.newWithinMs = (opts.newWithinMinutes ?? 24 * 60) * 60_000;
    this.activeWithinMinutes = opts.activeWithinMinutes ?? 60;
    this.maxIssues = opts.maxIssues ?? 25;
    this.maxEvents = opts.maxEventsPerIssue ?? 200;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Unresolved issues active in the last hour. One is ALERT when Sentry calls it new,
   * regressed or escalating, or when it first appeared recently; an issue that has
   * been going on for longer is WARN — known noise, not a new incident.
   */
  async listAlerts(project: string): Promise<MonitorState[]> {
    const { items } = await this.issues(project, `is:unresolved lastSeen:-${this.activeWithinMinutes}m`, this.maxIssues);
    const now = this.now().getTime();
    return items.map((issue) => {
      const firstSeen = new Date(issue.firstSeen);
      const fresh = now - firstSeen.getTime() <= this.newWithinMs;
      const alerting = (issue.substatus && ALERTING_SUBSTATUS.has(issue.substatus)) || fresh;
      return {
        id: issue.id,
        name: issue.shortId ? `${issue.shortId}: ${issue.title}` : issue.title,
        status: alerting ? 'ALERT' : 'WARN',
        service: project,
        query: 'is:unresolved',
        transitionedAt: firstSeen,
      };
    });
  }

  /** Every active issue's events in the window, as structured groups. */
  async readErrors(project: string, range: TimeRange, opts: { limit?: number } = {}): Promise<ObservedErrors> {
    const { items, truncated: moreIssues } = await this.issues(project, 'is:unresolved', this.maxIssues);
    const active = items.filter((i) => Date.parse(i.lastSeen) >= range.from.getTime() && Date.parse(i.firstSeen) <= range.to.getTime());
    const budget = opts.limit ?? this.maxEvents;
    const groups: ObservedErrorGroup[] = [];
    let truncated = moreIssues;
    for (const issue of active) {
      const { items: events, truncated: moreEvents } = await this.events(issue.id, range, budget);
      if (moreEvents) truncated = true;
      if (events.length === 0) continue;
      groups.push(toGroup(issue, events));
    }
    groups.sort((a, b) => b.count - a.count);
    return { kind: 'groups', groups, truncated };
  }

  /** For a connection test: the organization is readable with this token. */
  async checkOrganization(): Promise<{ slug: string; name: string }> {
    const org = await this.http.get<{ slug: string; name: string }>(`/api/0/organizations/${encodeURIComponent(this.org)}/`);
    return { slug: org.slug, name: org.name };
  }

  private issues(project: string, query: string, cap: number) {
    return this.paged<SentryIssue>(`/api/0/projects/${encodeURIComponent(this.org)}/${encodeURIComponent(project)}/issues/`, {
      query,
      ...(this.environment ? { environment: this.environment } : {}),
    }, cap);
  }

  private events(issueId: string, range: TimeRange, cap: number) {
    return this.paged<SentryEvent>(`/api/0/organizations/${encodeURIComponent(this.org)}/issues/${encodeURIComponent(issueId)}/events/`, {
      full: 'true',
      start: range.from.toISOString(),
      end: range.to.toISOString(),
      ...(this.environment ? { environment: this.environment } : {}),
    }, cap);
  }

  /** Follow `Link: <…>; rel="next"; results="true"; cursor="…"` up to `cap` items. */
  private async paged<T>(path: string, query: Record<string, string>, cap: number): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    let cursor: string | null = null;
    for (;;) {
      const { body, headers } = await this.http.getPage<T[]>(path, { ...query, ...(cursor ? { cursor } : {}) });
      items.push(...body);
      const next = nextCursor(headers.get('link'));
      if (!next) return { items, truncated: false };
      if (items.length >= cap) return { items: items.slice(0, cap), truncated: true };
      cursor = next;
    }
  }
}

/** The next page's cursor from a Sentry Link header, or null when there is none. */
export function nextCursor(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    if (!/rel="next"/.test(part)) continue;
    if (!/results="true"/.test(part)) return null;
    return /cursor="([^"]+)"/.exec(part)?.[1] ?? null;
  }
  return null;
}

function toGroup(issue: SentryIssue, events: SentryEvent[]): ObservedErrorGroup {
  const sorted = [...events].sort((a, b) => Date.parse(b.dateCreated) - Date.parse(a.dateCreated));
  const latest = sorted[0]!;
  const exception = exceptionOf(latest);
  const routes = new Set<string>();
  for (const e of events) {
    const route = e.tags?.find((t) => t.key === 'transaction')?.value ?? requestPath(e);
    if (route) routes.add(route);
  }
  const type = exception?.type ?? issue.metadata?.type ?? null;
  const value = exception?.value ?? issue.metadata?.value ?? '';
  return {
    id: issue.id,
    errorType: type,
    message: type ? `${type}: ${value}` : value || issue.title,
    // Sentry lists frames outermost first; innermost first here, as everywhere.
    frames: (exception?.stacktrace?.frames ?? []).map(toFrame).reverse(),
    count: events.length,
    firstSeen: new Date(sorted[sorted.length - 1]!.dateCreated),
    lastSeen: new Date(latest.dateCreated),
    routes: [...routes],
    url: issue.permalink ?? null,
  };
}

function exceptionOf(event: SentryEvent) {
  const entry = event.entries?.find((e) => e.type === 'exception') as { data: { values?: { type?: string | null; value?: string | null; stacktrace?: { frames?: SentryFrame[] } | null }[] } } | undefined;
  const values = entry?.data.values ?? [];
  // The last value is the exception that was raised; earlier ones are its causes.
  return values[values.length - 1] ?? null;
}

function requestPath(event: SentryEvent): string | null {
  const entry = event.entries?.find((e) => e.type === 'request') as { data: { url?: string; method?: string } } | undefined;
  if (!entry?.data.url) return null;
  try {
    const path = new URL(entry.data.url).pathname;
    return entry.data.method ? `${entry.data.method} ${path}` : path;
  } catch {
    return null;
  }
}

function toFrame(f: SentryFrame): ObservedFrame {
  return {
    file: f.absPath ?? f.filename ?? '<unknown>',
    line: f.lineNo ?? null,
    column: f.colNo ?? null,
    functionName: f.function ?? null,
    inApp: f.inApp === true,
  };
}
