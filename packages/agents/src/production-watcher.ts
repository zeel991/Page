import type {
  KnowledgeProvider,
  LogEntry,
  MonitorState,
  ObservabilityProvider,
  TimeRange,
} from '@pager/providers';
import type { AgentRunContext } from '@pager/observability';
import {
  assessNovelty,
  clusterErrors,
  failureKey,
  type ErrorCluster,
  type KnownFailureMode,
  type NoveltyVerdict,
} from './log-analysis.js';

/**
 * Production watcher.
 *
 * Datadog watches production continuously; this is what notices a monitor has gone
 * to Alert, pulls the logs around it, and decides whether the failure is something
 * the team already prepared for.
 *
 * The escalation rule is narrow on purpose: an alerting monitor is not by itself a
 * reason to wake an agent up. Escalation requires an alerting monitor AND error logs
 * that do not match a documented failure mode. A monitor firing with no errors
 * beneath it is far more likely to be a monitor problem than a production one.
 */

export interface ProductionAlert {
  service: string;
  monitor: MonitorState;
  firedAt: Date;
  logWindow: TimeRange;
  logs: LogEntry[];
  clusters: ErrorCluster[];
  /**
   * The distinct failures, loudest first: at most one per root frame, up to
   * `maxFailures`. Each is its own incident when novel — a deploy that breaks two
   * things has two bugs, and fixing the louder one says nothing about the other.
   */
  failures: DetectedFailure[];
  /** The failure this alert is about: the loudest novel one, else the loudest. */
  primary: ErrorCluster | null;
  novelty: NoveltyVerdict | null;
  escalate: boolean;
  /** Why this was or was not escalated. Always populated. */
  rationale: string;
  /**
   * Ids of the tool calls that produced this alert.
   *
   * Evidence derived from an alert cites these, so a claim about the logs points at
   * the query that actually returned them rather than at a summary.
   */
  toolCallIds: { monitors: string; logs: string | null };
  /**
   * The log read stopped at its limit with more available, so cluster counts are
   * lower bounds. Null when the provider did not say.
   */
  logsTruncated: boolean | null;
}

export interface DetectedFailure {
  /** Stable across polls: the root frame, or the type and signature without one. */
  key: string;
  cluster: ErrorCluster;
  novelty: NoveltyVerdict;
}

export interface WatchOptions {
  /** How many distinct failures to report. Default 3. */
  maxFailures?: number;
  /** Hard cap on how far back the evidence window may reach from now. */
  maxWindowMinutes?: number;
  /** How far back from the monitor transition to read logs. */
  lookbackMinutes?: number;
  /** How far forward. Alerts usually fire a few minutes after onset. */
  logLimit?: number;
  now?: () => Date;
}

const DEFAULT_LOOKBACK = 15;
const DEFAULT_MAX_WINDOW = 45;
const DEFAULT_MAX_FAILURES = 3;

/**
 * Pull known failure modes out of runbook text.
 *
 * A mode is a line that names an error type (a capitalised `...Error` or
 * `...Exception`) together with where or how it fails: a package (`@scope/name`),
 * a source path, a quoted or backticked message fragment, or an HTTP status. A line
 * naming only the type is kept, but with nothing to match on, so it can never
 * suppress a failure. Prose alone registers nothing — a runbook saying "sometimes
 * the gateway is slow" must not silence a novel gateway crash.
 */
export function extractKnownFailureModes(
  documents: readonly { title: string; content: string }[],
): KnownFailureMode[] {
  const modes: KnownFailureMode[] = [];
  const seen = new Set<string>();

  for (const doc of documents) {
    for (const line of doc.content.split('\n')) {
      const types = [...line.matchAll(/\b([A-Z][A-Za-z0-9_]*(?:Error|Exception))\b/g)].map((m) => m[1]!);
      if (types.length === 0) continue;
      const locations = [
        ...line.matchAll(/(@[a-z0-9][\w-]*(?:\.[\w-]+)*\/[\w-]+(?:\.[\w-]+)*)/gi),
        ...line.matchAll(/\b((?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|mjs|cjs|py|go|rb))\b/g),
      ].map((m) => m[1]!);
      const messages = [
        ...line.matchAll(/"([^"]{3,})"|`([^`]{3,})`/g),
      ].map((m) => (m[1] ?? m[2])!).filter((m) => !types.includes(m));
      for (const status of line.matchAll(/\b([45]\d\d)(?=s?\b)/g)) messages.push(status[1]!);

      for (const errorType of types) {
        const key = `${errorType}|${locations.join(',')}|${messages.join(',')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        modes.push({ errorType, locations, messages, description: line.trim().slice(0, 200), source: doc.title });
      }
    }
  }

  return modes;
}

export class ProductionWatcher {
  constructor(
    private readonly observability: ObservabilityProvider,
    private readonly knowledge: KnowledgeProvider | null = null,
  ) {}

  /** Documented failure modes for a service, from its runbooks. */
  async knownFailureModes(ctx: AgentRunContext, service: string): Promise<KnownFailureMode[]> {
    if (!this.knowledge) return [];
    try {
      const { value: hits } = await ctx.tool('notion.search', { query: service }, () =>
        this.knowledge!.search(`runbook ${service}`, 5),
      );

      const documents: { title: string; content: string }[] = [];
      for (const hit of hits) {
        const { value: doc } = await ctx.tool('notion.getDocument', { id: hit.id }, () =>
          this.knowledge!.getDocument(hit.id),
        );
        if (doc) documents.push({ title: doc.title, content: doc.content });
      }
      return extractKnownFailureModes(documents);
    } catch {
      // Runbooks are context, not a dependency. Losing them makes everything look
      // novel, which errs toward escalation — the safe direction.
      return [];
    }
  }

  /**
   * Check a service for an alerting monitor and, if one is firing, work out whether
   * it represents something new.
   */
  async check(
    ctx: AgentRunContext,
    service: string,
    opts: WatchOptions = {},
  ): Promise<ProductionAlert | null> {
    const now = opts.now ?? (() => new Date());

    const monitorsCall = await ctx.tool('datadog.listMonitors', { service }, () =>
      this.observability.listMonitors(service),
    );
    const monitors = monitorsCall.value;

    const alerting = monitors.find((m) => m.status === 'ALERT');
    if (!alerting) return null;

    const firedAt = alerting.transitionedAt ?? now();
    const at = now();

    /**
     * The window always runs up to NOW, never to a fixed offset after the monitor
     * fired.
     *
     * A monitor that is still in ALERT is telling you the failure is happening
     * now. Ending the window shortly after it first fired means that on a monitor
     * which has been red for an hour — or which never cleared across a deployment
     * — every error the service is currently producing falls outside the evidence,
     * and the investigation reasons about a failure that has since been fixed or
     * replaced by a different one. Observed exactly that: a monitor stuck at an old
     * transition time led to four investigations of a defect that was no longer
     * deployed, while the live failure went unexamined.
     *
     * The lookback still reaches back before the transition to catch onset, but is
     * bounded so a long-running alert cannot turn into an unbounded query.
     */
    const lookbackMs = (opts.lookbackMinutes ?? DEFAULT_LOOKBACK) * 60_000;
    const maxSpanMs = (opts.maxWindowMinutes ?? DEFAULT_MAX_WINDOW) * 60_000;
    const desiredFrom = new Date(firedAt.getTime() - lookbackMs);
    const earliestAllowed = new Date(at.getTime() - maxSpanMs);
    const logWindow: TimeRange = {
      from: desiredFrom > earliestAllowed ? desiredFrom : earliestAllowed,
      to: at,
    };

    const logsCall = await ctx.tool(
      'datadog.queryLogs',
      { service, level: 'error', from: logWindow.from, to: logWindow.to },
      () => this.observability.queryLogs(service, logWindow, { level: 'error', limit: opts.logLimit ?? 200 }),
    );
    const logs = logsCall.value;

    const clusters = clusterErrors(logs);

    if (clusters.length === 0) {
      // The most important non-escalation. A monitor in Alert with no errors under
      // it is a monitor that is wrong about production.
      return {
        service,
        monitor: alerting,
        firedAt,
        logWindow,
        logs,
        clusters,
        failures: [],
        primary: null,
        novelty: null,
        escalate: false,
        toolCallIds: { monitors: monitorsCall.toolCallId, logs: logsCall.toolCallId },
        logsTruncated: logs.truncated ?? null,
        rationale:
          `Monitor "${alerting.name}" is alerting but produced no error logs in the ` +
          `surrounding ${Math.round((logWindow.to.getTime() - logWindow.from.getTime()) / 60_000)} minutes. ` +
          `This is more likely a monitor problem than a production one, and is not escalated.`,
      };
    }

    // One failure per root frame: the loudest cluster at each, loudest first.
    const known = await this.knownFailureModes(ctx, service);
    const byKey = new Map<string, ErrorCluster>();
    for (const cluster of clusters) {
      const key = failureKey(cluster);
      if (!byKey.has(key)) byKey.set(key, cluster);
    }
    const failures: DetectedFailure[] = [...byKey]
      .slice(0, opts.maxFailures ?? DEFAULT_MAX_FAILURES)
      .map(([key, cluster]) => ({ key, cluster, novelty: assessNovelty(cluster, known) }));
    const novel = failures.filter((f) => f.novelty.novel);
    const chosen = novel[0] ?? failures[0]!;
    const primary = chosen.cluster;
    const others = novel.length > 1 ? ` ${novel.length - 1} other distinct failure(s) also match nothing documented, each its own incident.` : '';

    return {
      service,
      monitor: alerting,
      firedAt,
      logWindow,
      logs,
      clusters,
      failures,
      primary,
      novelty: chosen.novelty,
      escalate: novel.length > 0,
      toolCallIds: { monitors: monitorsCall.toolCallId, logs: logsCall.toolCallId },
      logsTruncated: logs.truncated ?? null,
      rationale: novel.length > 0
        ? `Monitor "${alerting.name}" is alerting and ${primary.count}${logs.truncated ? '+' : ''} error(s) match no documented ` +
          `failure mode${logs.truncated ? ' (the log read hit its limit, so counts are lower bounds)' : ''}. ` +
          `Escalating: ${primary.sample.slice(0, 120)}${others}`
        : `Monitor "${alerting.name}" is alerting, but ${failures.length > 1 ? `each of its ${failures.length} failures is` : 'this failure is'} documented. ${chosen.novelty.reason} ` +
          `Handle via its runbook rather than investigating from scratch.`,
    };
  }
}

/** A short, factual description of where an alert says the failure is. */
export function describeAlert(alert: ProductionAlert): string {
  if (!alert.primary) return alert.rationale;

  const cluster = alert.primary;
  const location = cluster.topApplicationFrame
    ? `${cluster.topApplicationFrame.file}:${cluster.topApplicationFrame.line}`
    : cluster.entirelyInDependencies
      ? 'entirely inside dependencies'
      : 'no stack trace available';

  return (
    `${cluster.errorType ?? 'Error'} ×${cluster.count} on ` +
    `${cluster.affectedRoutes.join(', ') || 'unknown route'} — ${location}`
  );
}
