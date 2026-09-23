import Link from 'next/link';
import { ApiUnavailableError, api, type IncidentRow, type Overview } from '@/lib/api';
import { ApiDown } from '@/components/api-down';
import { DitherPager } from '@/components/motion/dither';
import { CircleLink, Marquee } from '@/components/site/primitives';
import {
  Attribution,
  Empty,
  IncidentLink,
  PageHeader,
  Panel,
  Severity,
  State,
  Stat,
  StatGrid,
  dateOf,
  shortSha,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Colours for the state strip, keyed the same way the State badge is. In-flight
 * states fall back to a neutral tone: red is reserved for things that need a person.
 */
const STATE_BAR: Record<string, string> = {
  RESOLVED: 'bg-ok',
  AWAITING_APPROVAL: 'bg-sev3',
  UNRESOLVED: 'bg-sev2',
  EXTERNAL_INCIDENT: 'bg-sev4',
  FALSE_POSITIVE: 'bg-edge',
  APPROVAL_REJECTED: 'bg-edge',
};

function byState(incidents: IncidentRow[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const i of incidents) counts.set(i.state, (counts.get(i.state) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** The most severe open incident's level, or null when nothing is open. */
function topSeverity(open: IncidentRow[]): string | null {
  return open.map((i) => i.severity).sort()[0] ?? null;
}

export default async function OverviewPage() {
  let data: Overview;
  try {
    data = await api<Overview>('/api/overview');
  } catch (err) {
    if (err instanceof ApiUnavailableError) return <ApiDown url={err.url} />;
    throw err;
  }

  const { counts } = data;
  const active = data.incidents.filter((i) => !i.resolvedAt);
  const states = byState(data.incidents);
  const top = topSeverity(active);
  const autonomy = data.organization?.autonomyLevel ?? '—';

  return (
    <div>
      <PageHeader
        eyebrow={`${data.organization?.name ?? 'No organization'} · autonomy ${autonomy}`}
        title="Overview"
        meta={
          <span className="flex items-center gap-2">
            <span className={`inline-block size-2 rounded-full bg-paper ${active.length > 0 ? 'animate-blink' : ''}`} />
            {active.length > 0 ? `${active.length} open` : 'Nothing open'}
          </span>
        }
        aside={
          <div className="flex items-center gap-6">
            {/* The pager rings only when something is genuinely open. */}
            <div className="size-36 overflow-hidden shadow-[0_24px_48px_-20px_rgba(0,0,0,0.5)] md:size-48">
              <DitherPager
                headline={top ?? 'CLEAR'}
                detail={`${active.length} open`}
                buzz={active.length > 0}
                label={top ? `Pager showing ${top}, ${active.length} open` : 'Pager showing all clear'}
              />
            </div>
            <div className="hidden sm:block">
              <CircleLink href="/incidents">
                All
                <br />
                incidents
              </CircleLink>
            </div>
          </div>
        }
      />

      <Marquee
        className="display -mx-4 border-b border-graphite bg-ink py-4 text-[clamp(18px,2vw,26px)] text-paper [--marquee-duration:45s] md:-mx-8"
        items={[
          `${counts.activeIncidents} active`,
          `${counts.investigating} investigating`,
          `${counts.awaitingApproval} awaiting approval`,
          `${counts.unattributed} unattributed`,
          `${counts.deploymentsTracked} deployments watched`,
          `Autonomy ${autonomy}`,
          'A human decides',
        ]}
      />

      <div className="mt-10 space-y-12">
        <section>
          <div className="eyebrow mb-4 px-4 text-[10px] text-muted">Numbers</div>
          <StatGrid className="grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Active incidents" value={counts.activeIncidents} tone={counts.activeIncidents > 0 ? 'alert' : 'ok'} />
            <Stat label="Investigating" value={counts.investigating} />
            <Stat label="Awaiting approval" value={counts.awaitingApproval} tone={counts.awaitingApproval > 0 ? 'warn' : undefined} />
            <Stat label="Unattributed" value={counts.unattributed} />
            <Stat label="Resolved" value={counts.resolved} tone="ok" />
            <Stat label="Deployments watched" value={counts.deploymentsTracked} />
          </StatGrid>
        </section>

        {/*
          Drawn from the incidents the API returned (the most recent twenty), and
          labelled that way, so the strip never reads as an all-time distribution.
        */}
        {data.incidents.length > 0 && (
          <Panel title="By state" subtitle={`the ${data.incidents.length} most recent incidents`}>
            <div className="flex h-3 overflow-hidden bg-panel-2">
              {states.map(([state, n]) => (
                <div
                  key={state}
                  className={`${STATE_BAR[state] ?? 'bg-muted'} border-r-2 border-carbon last:border-0`}
                  style={{ width: `${(n / data.incidents.length) * 100}%` }}
                  title={`${state}: ${n}`}
                />
              ))}
            </div>
            <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
              {states.map(([state, n]) => (
                <li key={state} className="flex items-center gap-2 font-mono text-[11px] text-muted">
                  <span className={`size-2 ${STATE_BAR[state] ?? 'bg-muted'}`} />
                  {state}
                  <span className="text-text">{n}</span>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        <Panel
          title="Active incidents"
          subtitle={`${active.length} open`}
          actions={
            <Link href="/incidents" className="eyebrow text-[11px] text-dim hover:text-paper">
              All incidents →
            </Link>
          }
          dense
        >
          {active.length === 0 ? (
            <Empty>No active incidents. Production is healthy across watched services.</Empty>
          ) : (
            <ol className="border-t border-graphite">
              {active.map((i, n) => (
                <li key={i.id} className="group grid grid-cols-12 gap-x-4 gap-y-3 border-b border-graphite px-4 py-6">
                  <span className="display col-span-2 text-[clamp(32px,3.4vw,52px)] text-graphite transition-colors group-hover:text-signal md:col-span-1">
                    {String(n + 1).padStart(2, '0')}
                  </span>
                  <div className="col-span-10 md:col-span-8">
                    <div className="flex flex-wrap items-center gap-3">
                      <IncidentLink id={i.id} label={i.key} />
                      <Severity value={i.severity} />
                      <State value={i.state} />
                    </div>
                    <Link
                      href={`/incidents/${i.id}`}
                      className="display mt-3 block text-[clamp(22px,2.4vw,36px)] leading-[0.95] text-paper transition-colors group-hover:text-signal"
                    >
                      {i.title}
                    </Link>
                  </div>
                  <div className="col-span-12 md:col-span-3 md:text-right">
                    <Attribution value={i.deploymentAttribution} confidence={i.attributionConfidence} />
                    <div className="mt-1 font-mono text-[10px] text-dim">opened {dateOf(i.openedAt)}</div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Panel>

        <Panel
          title="Recent deployments"
          subtitle="watched for regressions"
          actions={
            <Link href="/deployments" className="eyebrow text-[11px] text-dim hover:text-paper">
              All deployments →
            </Link>
          }
          dense
        >
          {data.deployments.length === 0 ? (
            <Empty>No deployments recorded.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px]">
                <thead>
                  <tr className="eyebrow border-y border-graphite text-[10px] text-dim">
                    <th className="px-4 py-2 text-left font-medium">Revision</th>
                    <th className="px-2 py-2 text-left font-medium">Author</th>
                    <th className="px-2 py-2 text-left font-medium">Env</th>
                    <th className="px-2 py-2 text-left font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">Deployed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.deployments.map((d) => (
                    <tr key={d.id} className="border-b border-graphite transition-colors hover:bg-ink">
                      <td className="px-4 py-4 font-mono text-[12px]">
                        <span className="text-dim">{d.previousCommitSha ? `${shortSha(d.previousCommitSha)} → ` : '(first) '}</span>
                        <span className="font-semibold text-accent">{shortSha(d.commitSha)}</span>
                      </td>
                      <td className="px-2 py-4 text-[13px] text-muted">{d.authorName ?? 'unknown author'}</td>
                      <td className="px-2 py-4 font-mono text-[11px] text-dim">{d.environment}</td>
                      <td className="px-2 py-4 font-mono text-[11px] text-ok">{d.status}</td>
                      <td className="px-4 py-4 text-right font-mono text-[11px] text-dim">
                        {d.deployedAt ? dateOf(d.deployedAt) : dateOf(d.startedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
