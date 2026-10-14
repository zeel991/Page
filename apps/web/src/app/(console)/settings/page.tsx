import { api } from '@/lib/api';
import { PageHeader, Panel, dateOf } from '@/components/ui';
import { ActionForm } from '@/components/console/action-form';
import { Field, INPUT } from '@/components/console/fields';
import { Connection, DatadogForm, ModelKeyForm, SentryForm } from '@/components/console/setup/integrations';
import { openBillingPortal, saveBudget, saveNotion, saveResend, startCheckout, testIntegration } from '../actions';
import { NOTICES } from '@/lib/notices';
import { offeredPlans, planFacts, priceLabel, type PlanOffer } from '@/lib/pricing';
import { loadIntegrations, loadSetup, type IntegrationStatus } from '@/lib/setup';

export const dynamic = 'force-dynamic';

interface Billing {
  enabled: boolean;
  mode: 'test_mode' | 'live_mode' | null;
  subscription: { planId: string; status: string; nextBillingAt: string | null; cancelAtPeriodEnd: boolean; manageable: boolean } | null;
  plans: PlanOffer[];
}

interface Usage {
  monthToDate: { usd: number; unpricedCalls: number; calls: number };
  byKind: { kind: string; model: string; calls: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; usd: number }[];
  monthlyBudgetUsd: number | null;
}

function Section({ id, title, subtitle, status, provider, children }: {
  id: string;
  title: string;
  subtitle: string;
  status: IntegrationStatus;
  provider: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id}>
      <Panel title={title} subtitle={subtitle}>
        <Connection status={status} provider={provider}>{children}</Connection>
      </Panel>
    </section>
  );
}

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const { notice } = await searchParams;
  const shown = notice ? NOTICES[notice] : undefined;
  const [i, usage, me, billing, setup] = await Promise.all([
    loadIntegrations(),
    api<Usage>('/api/usage'),
    api<{ role: string }>('/api/me'),
    api<Billing>('/api/billing'),
    loadSetup(),
  ]);
  const currentPlan = setup.plan.plan;
  const keyIncluded = setup.plan.includedModelUsd != null;
  const sub = billing.subscription;
  // The statuses that keep a paid plan (ENTITLING_STATUSES in @pager/db).
  const paying = sub ? ['active', 'past_due'].includes(sub.status) : false;
  const resendFrom = typeof i.resend.config?.from === 'string' ? i.resend.config.from : '';

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Connections, keys and spend" title="Settings" meta={`your role: ${me.role}`} />

      {shown && (
        <div role="status" className={`border px-4 py-3 text-[12px] ${shown.tone === 'ok' ? 'border-ok/40 text-ok' : 'border-sev1/40 text-sev1'}`}>
          {shown.text}
        </div>
      )}

      <section id="billing">
        <Panel title="Plan and billing" subtitle={billing.enabled ? `payments by Dodo Payments${billing.mode === 'test_mode' ? ' · TEST MODE: no real charges' : ''}` : 'free beta: no paid plans yet'}>
          <p className="text-[13px] text-text">
            On the <strong>{currentPlan.name}</strong> plan.
            {sub && (
              <span className="text-muted">
                {' '}Subscription {sub.status.replace('_', ' ')}
                {paying && sub.nextBillingAt ? `, ${sub.cancelAtPeriodEnd ? 'ends' : 'renews'} ${dateOf(sub.nextBillingAt)}` : ''}.
              </span>
            )}
          </p>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {offeredPlans(billing.plans).map((p) => (
              <div key={p.id} className={`border px-4 py-3 ${p.id === currentPlan.id ? 'border-accent' : 'border-edge'}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[14px] font-semibold text-text">{p.name}</span>
                  <span className="font-mono text-[12px] text-muted">{priceLabel(p)}</span>
                </div>
                <ul className="mt-2 space-y-0.5 text-[12px] text-muted">
                  {planFacts(p).map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                {p.purchasable && p.id !== currentPlan.id && !paying && (
                  <ActionForm action={startCheckout.bind(null, p.id)} submit={`Upgrade to ${p.name}`} className="mt-3" />
                )}
              </div>
            ))}
          </div>
          {sub?.manageable && (
            <ActionForm action={openBillingPortal} submit="Manage billing" tone="quiet" className="mt-4" />
          )}
          <p className="mt-3 text-[11px] text-dim">
            Upgrades, payment details and cancellation are owners only. Cancelling keeps the plan until the end of the period that was paid for. See the <a href="/refunds" className="underline-offset-4 hover:underline">refund policy</a>.
          </p>
        </Panel>
      </section>

      <Panel title="Connected by install" subtitle="GitHub and Slack">
        <ul className="space-y-1 font-mono text-[11px] text-muted">
          <li>
            GitHub ·{' '}
            {i.github.installations.length ? i.github.installations.map((x) => x.accountLogin).join(', ') : <a href="/onboarding/github/install" className="text-accent underline-offset-4 hover:underline">install the app</a>}
          </li>
          <li>
            Slack · {i.slack ? `${i.slack.teamName} (${i.slack.teamId})` : <a href="/onboarding/slack/install" className="text-accent underline-offset-4 hover:underline">add to Slack</a>}
          </li>
        </ul>
        <div className="mt-3 flex flex-wrap gap-4">
          {i.github.installations.length > 0 && <ActionForm action={testIntegration.bind(null, 'github')} submit="Test GitHub" tone="quiet" />}
          {i.slack && <ActionForm action={testIntegration.bind(null, 'slack')} submit="Test Slack" tone="quiet" />}
        </div>
      </Panel>

      <Section id="datadog" title="Datadog" subtitle="where alerts and telemetry come from" status={i.datadog} provider="datadog">
        <DatadogForm status={i.datadog} />
      </Section>

      <Section id="sentry" title="Sentry" subtitle="an alternative alert source: new and regressed issues" status={i.sentry} provider="sentry">
        <SentryForm status={i.sentry} />
      </Section>

      <Section
        id="anthropic"
        title="Model key"
        subtitle={keyIncluded ? 'optional: the plan includes model spend' : `required for fixes: the ${currentPlan.name} plan includes no model spend`}
        status={i.anthropic}
        provider="anthropic"
      >
        <ModelKeyForm status={i.anthropic} />
      </Section>

      <Section id="notion" title="Notion" subtitle="optional; files the incident write-up" status={i.notion} provider="notion">
        <ActionForm action={saveNotion} submit="Save token">
          <Field label="Integration token" hint="Share the parent page with the integration in Notion.">
            <input name="token" type="password" autoComplete="off" required className={INPUT} />
          </Field>
        </ActionForm>
      </Section>

      <Section id="resend" title="Email" subtitle="optional; mails the write-up via Resend" status={i.resend} provider="resend">
        <ActionForm action={saveResend} submit="Save email" className="space-y-3">
          <Field label="Resend API key">
            <input name="apiKey" type="password" autoComplete="off" required className={INPUT} />
          </Field>
          <Field label="From" hint="A sender on a domain verified in Resend.">
            <input name="from" defaultValue={resendFrom} required className={INPUT} placeholder="Pager <pager@example.com>" />
          </Field>
        </ActionForm>
      </Section>

      <section id="budget">
        <Panel title="Model spend" subtitle="this calendar month, UTC">
          <div className="display text-[48px] text-text">${usage.monthToDate.usd.toFixed(2)}</div>
          <p className="mt-1 font-mono text-[11px] text-muted">
            {usage.monthToDate.calls} model call(s)
            {usage.monthToDate.unpricedCalls > 0 && (
              <span className="text-sev3"> · {usage.monthToDate.unpricedCalls} on a model with no known price, not included in the total</span>
            )}
          </p>
          {usage.byKind.length > 0 && (
            <table className="mt-4 w-full max-w-3xl">
              <tbody>
                {usage.byKind.map((r) => (
                  <tr key={`${r.kind}:${r.model}`} className="border-b border-edge-soft font-mono text-[11px] last:border-0">
                    <td className="py-1.5 pr-3 text-text">{r.kind}</td>
                    <td className="py-1.5 pr-3 text-muted">{r.model}</td>
                    <td className="py-1.5 pr-3 text-right text-muted">{r.calls} calls</td>
                    <td className="py-1.5 pr-3 text-right text-muted">{r.input_tokens.toLocaleString()} in · {r.cache_read_tokens.toLocaleString()} cached · {r.output_tokens.toLocaleString()} out</td>
                    <td className="py-1.5 text-right text-text">${r.usd.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <ActionForm action={saveBudget} submit="Save budget" className="mt-6 max-w-sm">
            <Field
              label="Monthly budget (USD)"
              hint="When reached, new investigations stop and say so. Blank: the plan's included spend on the deployment's key, or no cap on your own key. Owners only."
            >
              <input
                name="monthlyBudgetUsd"
                type="number"
                min={0}
                step="0.01"
                defaultValue={usage.monthlyBudgetUsd ?? ''}
                className={INPUT}
              />
            </Field>
          </ActionForm>
        </Panel>
      </section>
    </div>
  );
}
