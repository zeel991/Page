import Link from 'next/link';
import { api } from '@/lib/api';
import { NOTICES } from '@/lib/notices';
import { loadAvailableRepositories, loadChannels, loadInstallations, loadIntegrations, loadPickedRepositories, loadSetup } from '@/lib/setup';
import { Empty, PageHeader, Panel, dateOf } from '@/components/ui';
import { ActionForm } from '@/components/console/action-form';
import { INPUT } from '@/components/console/fields';
import { RepositoryPicker } from '@/components/console/setup/repositories';
import { ServiceForm } from '@/components/console/setup/service-form';
import { changeServiceRepository, setWatching, testHealth } from '../actions';

export const dynamic = 'force-dynamic';

interface ServiceRow {
  id: string;
  name: string;
  repositoryId: string | null;
  healthUrl: string | null;
  alertSource: string;
  slackChannelId: string | null;
  slackChannelName: string | null;
  autonomyLevel: string;
  readOnly: boolean;
  enabled: boolean;
  intervalSeconds: number;
  healthVerifiedAt: string | null;
  healthLastError: string | null;
  lastPolledAt: string | null;
  lastPollOutcome: string | null;
}

export default async function ServicesPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const { notice } = await searchParams;
  const shown = notice ? NOTICES[notice] : undefined;
  const [{ services }, picked, available, installations, channels, integrations, setup] = await Promise.all([
    api<{ services: ServiceRow[] }>('/api/services'),
    loadPickedRepositories(),
    loadAvailableRepositories(),
    loadInstallations(),
    loadChannels(),
    loadIntegrations(),
    loadSetup(),
  ]);
  const watched = services.filter((s) => s.alertSource !== 'sample');
  const samples = services.filter((s) => s.alertSource === 'sample');
  const repoName = new Map(picked.map((r) => [r.id, r.fullName]));
  const { used, limit } = setup.plan.services;
  const atLimit = used >= limit;

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="What it watches" title="Services" meta={`${used} of ${limit} on the ${setup.plan.plan.name} plan`} />

      {shown && (
        <div role="status" className={`border px-4 py-3 text-[12px] ${shown.tone === 'ok' ? 'border-ok/40 text-ok' : 'border-sev1/40 text-sev1'}`}>
          {shown.text}
        </div>
      )}

      <Panel title="Watched services" subtitle={`${watched.length} configured`} dense>
        {watched.length === 0 ? (
          <Empty>No services yet. Pick a repository below, then add a service for it.</Empty>
        ) : (
          <ul>
            {watched.map((s) => (
              <li key={s.id} className="border-b border-edge-soft px-4 py-4 last:border-0">
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="text-[14px] text-text">{s.name}</span>
                  <span className="font-mono text-[11px] text-muted">{(s.repositoryId && repoName.get(s.repositoryId)) ?? 'repository detached'}</span>
                  <span className="font-mono text-[11px] text-muted">→ {s.slackChannelName ? `#${s.slackChannelName}` : s.slackChannelId}</span>
                  <span className="font-mono text-[10px] text-accent">{s.readOnly ? 'L2 (read-only)' : s.autonomyLevel}</span>
                  <span className={`font-mono text-[10px] ${s.enabled ? 'text-ok' : 'text-dim'}`}>{s.enabled ? 'WATCHING' : 'NOT WATCHING'}</span>
                </div>
                <dl className="mt-2 grid gap-1 font-mono text-[11px] text-muted md:grid-cols-2">
                  <div>
                    <dt className="inline text-dim">health · </dt>
                    <dd className="inline break-all">{s.healthUrl}</dd>
                    {s.healthVerifiedAt ? (
                      <span className="text-ok"> · verified {dateOf(s.healthVerifiedAt)}</span>
                    ) : s.healthLastError ? (
                      <span className="text-sev1"> · {s.healthLastError}</span>
                    ) : (
                      <span className="text-sev3"> · not yet tested</span>
                    )}
                  </div>
                  <div>
                    <dt className="inline text-dim">last poll · </dt>
                    <dd className="inline">
                      {s.lastPolledAt ? `${dateOf(s.lastPolledAt)} — ${s.lastPollOutcome ?? ''}` : 'never polled'}
                    </dd>
                  </div>
                </dl>
                <div className="mt-2 flex flex-wrap items-end gap-4">
                  <ActionForm action={changeServiceRepository.bind(null, s.id)} submit="Change repository" tone="quiet" className="flex flex-wrap items-end gap-3">
                    <select name="repositoryId" defaultValue={s.repositoryId ?? ''} aria-label="Repository" className={`${INPUT} w-auto text-[11px]`}>
                      {picked.map((r) => (
                        <option key={r.id} value={r.id}>{r.fullName}</option>
                      ))}
                    </select>
                  </ActionForm>
                  <ActionForm action={testHealth.bind(null, s.id)} submit="Test health URL" tone="quiet" />
                  <ActionForm
                    action={setWatching.bind(null, s.id, !s.enabled)}
                    submit={s.enabled ? 'Stop watching' : 'Start watching'}
                    tone={s.enabled ? 'quiet' : 'primary'}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <section id="repositories">
        <Panel title="Repositories" subtitle="from your GitHub App installation">
          <RepositoryPicker installations={installations} available={available} picked={picked} />
        </Panel>
      </section>

      <section id="new">
        <Panel title="Add a service" subtitle={atLimit ? `the ${setup.plan.plan.name} plan's ${limit} service(s) are used` : 'watched from the moment it is saved; test its health URL first'}>
          {atLimit ? (
            <p className="text-[12px] text-muted">This workspace is at its plan&apos;s service limit. Paid plans are not yet available.</p>
          ) : (
            <ServiceForm
              picked={picked}
              channels={channels}
              alerts={{ datadog: integrations.datadog.configured, sentry: integrations.sentry.configured }}
            />
          )}
          <p className="mt-4 text-[11px] text-dim">
            Alerts come from Datadog or Sentry — connect one in <Link href="/settings#datadog" className="text-accent underline-offset-4 hover:underline">Settings</Link>, or walk through <Link href="/onboarding?edit" className="text-accent underline-offset-4 hover:underline">Setup</Link>.
          </p>
        </Panel>
      </section>

      {samples.length > 0 && (
        <Panel title="Sample" subtitle="from a test incident; not watched, not on your plan">
          <ul className="font-mono text-[11px] text-muted">
            {samples.map((s) => (
              <li key={s.id}>{s.name}</li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
