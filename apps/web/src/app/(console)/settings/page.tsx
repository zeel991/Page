import { DATADOG_API_HOSTS } from '@pager/core';
import { api } from '@/lib/api';
import { PageHeader, Panel, dateOf } from '@/components/ui';
import { ActionForm } from '@/components/console/action-form';
import { Field, INPUT } from '@/components/console/fields';
import { saveAnthropic, saveBudget, saveDatadog, saveNotion, saveResend, testIntegration } from '../actions';

export const dynamic = 'force-dynamic';

interface IntegrationStatus {
  configured: boolean;
  baseUrl?: string | null;
  config?: Record<string, unknown> | null;
  verifiedAt?: string | null;
  lastError?: string | null;
  keys: { kind: string; last4: string }[];
}

interface Integrations {
  github: { installations: { id: string; accountLogin: string }[] };
  slack: { teamId: string; teamName: string } | null;
  datadog: IntegrationStatus;
  notion: IntegrationStatus;
  resend: IntegrationStatus;
  anthropic: IntegrationStatus;
}

interface Usage {
  monthToDate: { usd: number; unpricedCalls: number; calls: number };
  byKind: { kind: string; model: string; calls: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; usd: number }[];
  monthlyBudgetUsd: number | null;
}

/** What is stored, stated plainly: never the secret, only that one exists and how it ends. */
function Stored({ status }: { status: IntegrationStatus }) {
  if (!status.configured) return <p className="font-mono text-[11px] text-dim">Not connected.</p>;
  return (
    <p className="font-mono text-[11px] text-muted">
      {status.keys.map((k) => `${k.kind} ····${k.last4}`).join(' · ') || 'no keys stored'}
      {status.verifiedAt ? (
        <span className="text-ok"> · verified {dateOf(status.verifiedAt)}</span>
      ) : status.lastError ? (
        <span className="text-sev1"> · last test failed: {status.lastError}</span>
      ) : (
        <span className="text-sev3"> · not yet tested</span>
      )}
    </p>
  );
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
        <Stored status={status} />
        <div className="mt-4 max-w-xl">{children}</div>
        {status.configured && <ActionForm action={testIntegration.bind(null, provider)} submit="Test connection" tone="quiet" className="mt-2" />}
      </Panel>
    </section>
  );
}

export default async function SettingsPage() {
  const [i, usage, me] = await Promise.all([
    api<Integrations>('/api/integrations'),
    api<Usage>('/api/usage'),
    api<{ role: string }>('/api/me'),
  ]);
  const hosts = [...DATADOG_API_HOSTS];
  const site = i.datadog.baseUrl ?? 'https://api.datadoghq.com';
  const resendFrom = typeof i.resend.config?.from === 'string' ? i.resend.config.from : '';

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Connections, keys and spend" title="Settings" meta={`your role: ${me.role}`} />

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
        <ActionForm action={saveDatadog} submit="Save Datadog" className="space-y-3">
          <Field label="Site" hint="Keys are only ever sent to Datadog's own API host for your site.">
            <select name="site" defaultValue={site} className={INPUT}>
              {hosts.map((h) => (
                <option key={h} value={`https://${h}`}>{h}</option>
              ))}
            </select>
          </Field>
          <Field label="API key" hint={i.datadog.configured ? 'Leave blank to keep the stored key.' : undefined}>
            <input name="apiKey" type="password" autoComplete="off" className={INPUT} />
          </Field>
          <Field label="Application key" hint="Needs read access to monitors, metrics and logs.">
            <input name="appKey" type="password" autoComplete="off" className={INPUT} />
          </Field>
        </ActionForm>
      </Section>

      <Section id="anthropic" title="Model key" subtitle="optional; bring your own Anthropic key" status={i.anthropic} provider="anthropic">
        <ActionForm action={saveAnthropic} submit="Save key">
          <Field label="Anthropic API key" hint="Stored encrypted. Runs in this workspace use it instead of the deployment's key.">
            <input name="apiKey" type="password" autoComplete="off" required className={INPUT} />
          </Field>
        </ActionForm>
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
