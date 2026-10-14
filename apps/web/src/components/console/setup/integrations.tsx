import { DATADOG_API_HOSTS } from '@pager/core';
import { ActionForm } from '@/components/console/action-form';
import { Field, INPUT } from '@/components/console/fields';
import { dateOf } from '@/components/ui';
import { saveAnthropic, saveDatadog, saveSentry, testIntegration } from '@/app/(console)/actions';
import type { IntegrationStatus } from '@/lib/setup';

/** What is stored, stated plainly: never the secret, only that one exists and how it ends. */
export function Stored({ status }: { status: IntegrationStatus }) {
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

/** A connection's stored state, its form, and a test button once something is stored. */
export function Connection({ status, provider, children }: { status: IntegrationStatus; provider: string; children: React.ReactNode }) {
  return (
    <div>
      <Stored status={status} />
      <div className="mt-4 max-w-xl">{children}</div>
      {status.configured && <ActionForm action={testIntegration.bind(null, provider)} submit="Test connection" tone="quiet" className="mt-2" />}
    </div>
  );
}

export function DatadogForm({ status }: { status: IntegrationStatus }) {
  const site = status.baseUrl ?? 'https://api.datadoghq.com';
  return (
    <ActionForm action={saveDatadog} submit="Save Datadog" className="space-y-3">
      <Field label="Site" hint="Keys are only ever sent to Datadog's own API host for your site.">
        <select name="site" defaultValue={site} className={INPUT}>
          {[...DATADOG_API_HOSTS].map((h) => (
            <option key={h} value={`https://${h}`}>{h}</option>
          ))}
        </select>
      </Field>
      <Field label="API key" hint={status.configured ? 'Leave blank to keep the stored key.' : undefined}>
        <input name="apiKey" type="password" autoComplete="off" className={INPUT} />
      </Field>
      <Field label="Application key" hint="Needs read access to monitors, metrics and logs.">
        <input name="appKey" type="password" autoComplete="off" className={INPUT} />
      </Field>
    </ActionForm>
  );
}

export function SentryForm({ status }: { status: IntegrationStatus }) {
  const org = typeof status.config?.organization === 'string' ? status.config.organization : '';
  return (
    <ActionForm action={saveSentry} submit="Save Sentry" className="space-y-3">
      <Field label="Sentry URL" hint="https://sentry.io, or your region's host (https://us.sentry.io, https://de.sentry.io).">
        <input name="baseUrl" defaultValue={status.baseUrl ?? 'https://sentry.io'} className={INPUT} />
      </Field>
      <Field label="Organization slug">
        <input name="organization" defaultValue={org} required className={INPUT} placeholder="acme" />
      </Field>
      <Field label="Auth token" hint={status.configured ? 'Leave blank to keep the stored token. Needs event:read and project:read.' : 'Needs event:read and project:read.'}>
        <input name="token" type="password" autoComplete="off" className={INPUT} />
      </Field>
      <Field label="Webhook client secret" hint="Optional. With it, Sentry's issue webhooks (to /webhooks/sentry on the API) wake the poll at once.">
        <input name="webhookSecret" type="password" autoComplete="off" className={INPUT} />
      </Field>
    </ActionForm>
  );
}

export function ModelKeyForm({ status }: { status: IntegrationStatus }) {
  return (
    <ActionForm action={saveAnthropic} submit="Save key">
      <Field label="Anthropic API key" hint={status.configured ? 'Stored encrypted. Saving replaces the stored key.' : 'Stored encrypted. Runs in this workspace use it.'}>
        <input name="apiKey" type="password" autoComplete="off" required className={INPUT} />
      </Field>
    </ActionForm>
  );
}
