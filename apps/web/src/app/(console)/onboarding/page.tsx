import Link from 'next/link';
import { redirect } from 'next/navigation';
import { api } from '@/lib/api';
import { NOTICES } from '@/lib/notices';
import {
  loadAvailableRepositories,
  loadChannels,
  loadInstallations,
  loadIntegrations,
  loadPickedRepositories,
  loadSetup,
  type SetupStep,
} from '@/lib/setup';
import { PageHeader, Panel, dateOf } from '@/components/ui';
import { ActionForm } from '@/components/console/action-form';
import { RepositoryPicker } from '@/components/console/setup/repositories';
import { Connection, DatadogForm, ModelKeyForm, SentryForm } from '@/components/console/setup/integrations';
import { ServiceForm } from '@/components/console/setup/service-form';
import { sendTestIncident, setWatching, testHealth, testIntegration } from '../actions';

export const dynamic = 'force-dynamic';

interface ServiceRow {
  id: string;
  name: string;
  healthUrl: string | null;
  alertSource: string;
  slackChannelName: string | null;
  slackChannelId: string | null;
  enabled: boolean;
  healthVerifiedAt: string | null;
  healthLastError: string | null;
  lastPolledAt: string | null;
  lastPollOutcome: string | null;
}

const MARK: Record<SetupStep['status'], { glyph: string; tone: string; word: string }> = {
  done: { glyph: '✓', tone: 'text-ok', word: 'DONE' },
  attention: { glyph: '!', tone: 'text-sev3', word: 'NEEDS ATTENTION' },
  todo: { glyph: '○', tone: 'text-dim', word: 'TO DO' },
};

/**
 * Guided setup: five steps in the order they depend on each other, each with its
 * form right here. The next open step is expanded; done steps fold up and can be
 * reopened. Once a service is being watched, the console lands on Overview instead.
 */
export default async function SetupPage({ searchParams }: { searchParams: Promise<{ notice?: string; edit?: string }> }) {
  const { notice, edit } = await searchParams;
  const setup = await loadSetup();
  if (setup.complete && !notice && edit === undefined) redirect('/dashboard');

  const [integrations, installations, picked, available, channels, { services }] = await Promise.all([
    loadIntegrations(),
    loadInstallations(),
    loadPickedRepositories(),
    loadAvailableRepositories(),
    loadChannels(),
    api<{ services: ServiceRow[] }>('/api/services'),
  ]);
  const shown = notice ? NOTICES[notice] : undefined;
  const done = setup.steps.filter((s) => s.status === 'done').length;
  const next = setup.steps.find((s) => s.status !== 'done');
  const service = services.find((s) => s.alertSource !== 'sample') ?? null;
  const test = setup.testIncident;
  const keyIncluded = setup.plan.includedModelUsd != null;

  const body: Record<SetupStep['id'], React.ReactNode> = {
    github: <RepositoryPicker installations={installations} available={available} picked={picked} />,
    alerts: (
      <div className="space-y-6">
        <p className="text-[12px] text-muted">One is enough. Alerts for the service come from whichever you connect; the other can wait.</p>
        <div className="grid gap-8 md:grid-cols-2">
          <div>
            <h3 className="eyebrow mb-2 text-[10px] text-text">Datadog</h3>
            <Connection status={integrations.datadog} provider="datadog"><DatadogForm status={integrations.datadog} /></Connection>
          </div>
          <div>
            <h3 className="eyebrow mb-2 text-[10px] text-text">Sentry</h3>
            <Connection status={integrations.sentry} provider="sentry"><SentryForm status={integrations.sentry} /></Connection>
          </div>
        </div>
      </div>
    ),
    slack: integrations.slack ? (
      <div className="space-y-3">
        <p className="font-mono text-[11px] text-muted">Connected to {integrations.slack.teamName}.</p>
        <div className="flex flex-wrap gap-4">
          <ActionForm action={testIntegration.bind(null, 'slack')} submit="Test Slack" tone="quiet" />
          <a href="/onboarding/slack/install" className="self-center text-[11px] text-accent underline-offset-4 hover:underline">Connect a different workspace →</a>
        </div>
      </div>
    ) : (
      <div className="space-y-3">
        <p className="text-[12px] leading-relaxed text-muted">
          Incidents are reported in a Slack channel you choose in the last step. The bot only posts there; it never reads messages.
        </p>
        <a href="/onboarding/slack/install" className="inline-block bg-signal px-4 py-2 text-[12px] font-semibold text-paper hover:opacity-90">
          Add to Slack →
        </a>
      </div>
    ),
    model_key: (
      <div className="space-y-4">
        <p className="text-[12px] leading-relaxed text-muted">
          {keyIncluded
            ? `The ${setup.plan.plan.name} plan includes model spend, so a key of your own is optional; with one, runs use it instead.`
            : `The ${setup.plan.plan.name} plan includes no model spend. Without a key the agent still detects, investigates and reports, but never prepares a fix. The key is stored encrypted and used only for this workspace's runs.`}
        </p>
        <Connection status={integrations.anthropic} provider="anthropic"><ModelKeyForm status={integrations.anthropic} /></Connection>
      </div>
    ),
    service: service ? (
      <div className="space-y-3">
        <p className="font-mono text-[11px] text-muted">
          {service.name} → {service.slackChannelName ? `#${service.slackChannelName}` : service.slackChannelId} · alerts from {service.alertSource}
        </p>
        <p className="font-mono text-[11px] text-muted">
          health · <span className="break-all">{service.healthUrl}</span>
          {service.healthVerifiedAt ? (
            <span className="text-ok"> · verified {dateOf(service.healthVerifiedAt)}</span>
          ) : service.healthLastError ? (
            <span className="text-sev1"> · {service.healthLastError}</span>
          ) : (
            <span className="text-sev3"> · not yet tested</span>
          )}
        </p>
        <p className="font-mono text-[11px] text-muted">
          last poll · {service.lastPolledAt ? `${dateOf(service.lastPolledAt)} — ${service.lastPollOutcome ?? ''}` : 'never polled'}
          {!service.enabled && <span className="text-sev3"> · not watching</span>}
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <ActionForm action={testHealth.bind(null, service.id)} submit="Test health URL" tone="quiet" />
          {!service.enabled && <ActionForm action={setWatching.bind(null, service.id, true)} submit="Start watching" />}
          <Link href="/services" className="text-[11px] text-accent underline-offset-4 hover:underline">Edit in Services →</Link>
        </div>
      </div>
    ) : (
      <ServiceForm
        picked={picked}
        channels={channels}
        alerts={{ datadog: integrations.datadog.configured, sentry: integrations.sentry.configured }}
        compact
      />
    ),
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="From sign-up to a watched service"
        title="Setup"
        meta={setup.complete ? 'Setup complete' : `${done} of ${setup.steps.length} steps done`}
      />

      {shown && (
        <div role="status" className={`border px-4 py-3 text-[12px] ${shown.tone === 'ok' ? 'border-ok/40 text-ok' : 'border-sev1/40 text-sev1'}`}>
          {shown.text}
        </div>
      )}

      {setup.complete && (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-ok/40 px-4 py-3 text-[12px] text-ok">
          <span>A service is being watched. Everything below can still be changed.</span>
          <Link href="/dashboard" className="eyebrow border border-ok/60 px-3 py-1.5 text-[10px] text-ok hover:bg-ok hover:text-carbon">Go to Overview →</Link>
        </div>
      )}

      <div className="h-1 w-full bg-panel-2" aria-hidden>
        <div className="h-1 bg-ok transition-[width] duration-500" style={{ width: `${(done / setup.steps.length) * 100}%` }} />
      </div>

      <ol className="space-y-3">
        {setup.steps.map((s, n) => {
          const mark = MARK[s.status];
          const isNext = s.id === next?.id;
          return (
            <li key={s.id}>
              <details open={isNext} className={`group border ${isNext ? 'border-accent' : 'border-edge-soft'}`}>
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-4 px-4 py-4 [&::-webkit-details-marker]:hidden">
                  <span className="font-mono text-[10px] text-dim">{String(n + 1).padStart(2, '0')}</span>
                  <span className={`w-4 font-mono text-[14px] ${mark.tone}`} aria-hidden>{mark.glyph}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] text-text">{s.label}</span>
                    {s.detail && <span className="mt-0.5 block font-mono text-[11px] break-words text-muted">{s.detail}</span>}
                  </span>
                  <span className={`font-mono text-[10px] ${mark.tone}`}>{mark.word}</span>
                  <span className="eyebrow text-[10px] text-dim group-open:hidden">{s.status === 'done' ? 'Edit' : 'Open'} ↓</span>
                  <span className="eyebrow hidden text-[10px] text-dim group-open:inline">Close ↑</span>
                </summary>
                <div className="border-t border-edge-soft px-4 py-5">{body[s.id]}</div>
              </details>
            </li>
          );
        })}
      </ol>

      <Panel title="See it work first" subtitle="no connections needed">
        <p className="max-w-2xl text-[12px] leading-relaxed text-muted">
          A test incident runs the demo scenario, a bad deploy to a checkout service, against built-in stand-ins for GitHub,
          Datadog and Slack. It investigates, reproduces the failure, writes and validates a fix, and stops at the approval step.
          Nothing touches your repositories or your Slack, and it does not count against your plan.
        </p>
        <ActionForm action={sendTestIncident} submit="Send a test incident" tone="quiet" className="mt-4" />
        {test && (
          <p className="mt-3 font-mono text-[11px] text-muted">
            Last test: <span className={test.status === 'done' ? 'text-ok' : test.status === 'failed' ? 'text-sev1' : 'text-sev3'}>{test.status}</span>
            {test.error && <span className="text-sev1"> — {test.error}</span>}
            {test.status === 'done' && (
              <>
                {' '}· <Link href="/incidents" className="text-accent underline-offset-4 hover:underline">see it in Incidents</Link>
              </>
            )}
          </p>
        )}
      </Panel>

      <p className="text-[11px] text-dim">
        On the {setup.plan.plan.name} plan: {setup.plan.services.limit} service(s), {setup.plan.incidentsThisMonth.limit} incidents a month.
      </p>
    </div>
  );
}
