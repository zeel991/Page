import Link from 'next/link';
import { api } from '@/lib/api';
import { NOTICES } from '@/lib/notices';
import { PageHeader, Panel } from '@/components/ui';
import { ActionForm } from '@/components/console/action-form';
import { sendTestIncident } from '../actions';

export const dynamic = 'force-dynamic';

interface Step {
  id: string;
  label: string;
  status: 'done' | 'todo' | 'attention';
  detail: string | null;
}

interface Onboarding {
  steps: Step[];
  plan: {
    plan: { id: string; name: string };
    services: { used: number; limit: number };
    incidentsThisMonth: { used: number; limit: number };
    includedModelUsd: number | null;
  };
  testIncident: { status: string; error: string | null; at: string } | null;
}

/** Where each step is done. Install steps start at GitHub or Slack; the rest are forms here. */
const ACTION: Record<string, { href: string; label: string } | null> = {
  signed_in: null,
  github: { href: '/onboarding/github/install', label: 'Install on GitHub' },
  repository: { href: '/services#repositories', label: 'Pick a repository' },
  datadog: { href: '/settings#datadog', label: 'Connect Datadog' },
  slack: { href: '/onboarding/slack/install', label: 'Add to Slack' },
  service: { href: '/services#new', label: 'Add a service' },
  health: { href: '/services', label: 'Test the health URL' },
  watching: { href: '/services', label: 'Start watching' },
};

const MARK: Record<Step['status'], { glyph: string; tone: string; word: string }> = {
  done: { glyph: '✓', tone: 'text-ok', word: 'DONE' },
  attention: { glyph: '!', tone: 'text-sev3', word: 'NEEDS ATTENTION' },
  todo: { glyph: '○', tone: 'text-dim', word: 'TO DO' },
};

/** Install links leave the site, so they are plain anchors rather than client-side links. */
const external = (href: string) => href.endsWith('/install');

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const { notice } = await searchParams;
  const shown = notice ? NOTICES[notice] : undefined;
  const data = await api<Onboarding>('/api/onboarding');
  const done = data.steps.filter((s) => s.status === 'done').length;
  const next = data.steps.find((s) => s.status !== 'done');
  const test = data.testIncident;

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="From sign-up to a watched service" title="Setup" meta={`${done} of ${data.steps.length} steps done`} />

      {shown && (
        <div role="status" className={`border px-4 py-3 text-[12px] ${shown.tone === 'ok' ? 'border-ok/40 text-ok' : 'border-sev1/40 text-sev1'}`}>
          {shown.text}
        </div>
      )}

      <Panel title="Checklist" subtitle="each step read from what actually exists" dense>
        <ol>
          {data.steps.map((s) => {
            const mark = MARK[s.status];
            const action = s.status === 'done' ? null : ACTION[s.id];
            return (
              <li key={s.id} className={`flex flex-wrap items-center gap-4 border-b border-edge-soft px-4 py-3 last:border-0 ${s.id === next?.id ? 'bg-accent/5' : ''}`}>
                <span className={`w-5 font-mono text-[14px] ${mark.tone}`} aria-hidden>{mark.glyph}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-text">{s.label}</div>
                  {s.detail && <div className="mt-0.5 font-mono text-[11px] break-words text-muted">{s.detail}</div>}
                </div>
                <span className={`font-mono text-[10px] ${mark.tone}`}>{mark.word}</span>
                {action &&
                  (external(action.href) ? (
                    <a href={action.href} className="eyebrow border border-edge px-3 py-1.5 text-[10px] text-text hover:border-paper">
                      {action.label} →
                    </a>
                  ) : (
                    <Link href={action.href} className="eyebrow border border-edge px-3 py-1.5 text-[10px] text-text hover:border-paper">
                      {action.label} →
                    </Link>
                  ))}
              </li>
            );
          })}
        </ol>
      </Panel>

      <Panel title="Try it first" subtitle="no connections needed">
        <p className="max-w-2xl text-[12px] leading-relaxed text-muted">
          A test incident runs the demo scenario — a bad deploy to a checkout service — against built-in stand-ins for GitHub,
          Datadog and Slack. It investigates, reproduces the failure, writes and validates a fix, and stops at the approval step.
          Nothing touches your repositories or your Slack, and it does not count against your plan.
        </p>
        <ActionForm action={sendTestIncident} submit="Send a test incident" className="mt-4" />
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

      <Panel title="Your plan" subtitle={data.plan.plan.name}>
        <dl className="grid max-w-2xl grid-cols-3 gap-6">
          <div>
            <dt className="eyebrow text-[10px] text-dim">Services watched</dt>
            <dd className="display mt-2 text-[32px] text-text">
              {data.plan.services.used}/{data.plan.services.limit}
            </dd>
          </div>
          <div>
            <dt className="eyebrow text-[10px] text-dim">Incidents this month</dt>
            <dd className="display mt-2 text-[32px] text-text">
              {data.plan.incidentsThisMonth.used}/{data.plan.incidentsThisMonth.limit}
            </dd>
          </div>
          <div>
            <dt className="eyebrow text-[10px] text-dim">Included model spend</dt>
            <dd className="display mt-2 text-[32px] text-text">{data.plan.includedModelUsd == null ? 'none' : `$${data.plan.includedModelUsd}`}</dd>
          </div>
        </dl>
        <p className="mt-3 text-[11px] text-muted">
          Included model spend applies when runs use this deployment&apos;s model key. With your own key (in{' '}
          <Link href="/settings#anthropic" className="text-accent underline-offset-4 hover:underline">Settings</Link>), the cap is the budget you set.
        </p>
      </Panel>
    </div>
  );
}
