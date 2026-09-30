'use server';

import { revalidatePath } from 'next/cache';
import { apiCall, type ApiResult } from '@/lib/api';

/**
 * The console's writes. Each one is a call to the API as the signed-in member; the
 * API decides whether their role allows it and validates the input. What comes back
 * to the form is the API's own verdict, field problems included.
 */

export interface FormState {
  ok: boolean;
  message: string;
  problems?: Record<string, string>;
}

function stateOf(r: ApiResult<Record<string, unknown>>, success: string): FormState {
  if (r.ok) return { ok: true, message: success };
  if (r.status === 403) return { ok: false, message: 'Your role in this workspace does not allow this.' };
  return {
    ok: false,
    message: r.body.reason ?? (r.body.problems ? 'Fix the fields marked below.' : (r.body.error ?? `refused (${r.status})`)),
    ...(r.body.problems ? { problems: r.body.problems } : {}),
  };
}

const text = (form: FormData, key: string): string => String(form.get(key) ?? '').trim();
/** A secret field left blank keeps the stored value rather than erasing it. */
const secret = (form: FormData, key: string): string | undefined => text(form, key) || undefined;

function refresh() {
  revalidatePath('/onboarding');
  revalidatePath('/services');
  revalidatePath('/settings');
}

// ── Onboarding ────────────────────────────────────────────────────────────────

export async function sendTestIncident(_prev: FormState | null): Promise<FormState> {
  const r = await apiCall('/api/test-incident', { method: 'POST' });
  refresh();
  return stateOf(r, 'Queued. The sample incident runs against built-in twins, not your systems.');
}

// ── Repositories and services ────────────────────────────────────────────────

export async function addRepository(fullName: string, _prev: FormState | null): Promise<FormState> {
  const r = await apiCall('/api/repositories', { method: 'POST', body: { fullName } });
  refresh();
  return stateOf(r, `${fullName} added.`);
}

export async function createService(_prev: FormState | null, form: FormData): Promise<FormState> {
  const channel = text(form, 'slackChannel');
  const [slackChannelId, slackChannelName] = channel.split('|');
  const recipients = text(form, 'emailRecipients');
  const r = await apiCall('/api/services', {
    method: 'POST',
    body: {
      name: text(form, 'name'),
      repositoryId: text(form, 'repositoryId'),
      healthUrl: text(form, 'healthUrl'),
      alertSource: text(form, 'alertSource') || 'datadog',
      slackChannelId: slackChannelId ?? '',
      slackChannelName: slackChannelName ?? null,
      baseBranch: text(form, 'baseBranch') || null,
      autonomyLevel: text(form, 'autonomyLevel') || 'L3',
      readOnly: form.get('readOnly') === 'on',
      intervalSeconds: Number(text(form, 'intervalSeconds') || 60),
      notionParentPageId: text(form, 'notionParentPageId') || null,
      emailRecipients: recipients ? recipients.split(/[\s,]+/).filter(Boolean) : [],
    },
  });
  refresh();
  return stateOf(r, 'Service saved and being watched. Test its health URL to confirm it reports a revision.');
}

export async function testHealth(serviceId: string, _prev: FormState | null): Promise<FormState> {
  const r = await apiCall<{ result: { ok: boolean; detail?: string; error?: string } }>(`/api/services/${serviceId}/test-health`, { method: 'POST' });
  refresh();
  if (!r.ok) return stateOf(r, '');
  return r.body.result.ok ? { ok: true, message: r.body.result.detail ?? 'reports a revision' } : { ok: false, message: r.body.result.error ?? 'no revision' };
}

export async function setWatching(serviceId: string, enabled: boolean, _prev: FormState | null): Promise<FormState> {
  const r = await apiCall(`/api/services/${serviceId}/enabled`, { method: 'POST', body: { enabled } });
  refresh();
  return stateOf(r, enabled ? 'Watching. The first poll runs within a minute.' : 'Stopped watching.');
}

// ── Integrations ─────────────────────────────────────────────────────────────

export async function saveDatadog(_prev: FormState | null, form: FormData): Promise<FormState> {
  const r = await apiCall('/api/integrations/datadog', {
    method: 'PUT',
    body: { site: text(form, 'site'), apiKey: secret(form, 'apiKey'), appKey: secret(form, 'appKey') },
  });
  refresh();
  return stateOf(r, 'Saved. Test the connection to confirm the keys work.');
}

export async function saveSentry(_prev: FormState | null, form: FormData): Promise<FormState> {
  const r = await apiCall('/api/integrations/sentry', {
    method: 'PUT',
    body: {
      baseUrl: text(form, 'baseUrl') || 'https://sentry.io',
      organization: text(form, 'organization'),
      token: secret(form, 'token'),
      webhookSecret: secret(form, 'webhookSecret'),
    },
  });
  refresh();
  return stateOf(r, 'Saved. Test the connection to confirm the token can read the organization.');
}

export async function saveNotion(_prev: FormState | null, form: FormData): Promise<FormState> {
  const r = await apiCall('/api/integrations/notion', { method: 'PUT', body: { token: text(form, 'token') } });
  refresh();
  return stateOf(r, 'Saved.');
}

export async function saveResend(_prev: FormState | null, form: FormData): Promise<FormState> {
  const r = await apiCall('/api/integrations/resend', { method: 'PUT', body: { apiKey: text(form, 'apiKey'), from: text(form, 'from') } });
  refresh();
  return stateOf(r, 'Saved.');
}

export async function saveAnthropic(_prev: FormState | null, form: FormData): Promise<FormState> {
  const r = await apiCall('/api/integrations/anthropic', { method: 'PUT', body: { apiKey: text(form, 'apiKey') } });
  refresh();
  return stateOf(r, 'Saved. Runs in this workspace now use your key.');
}

export async function testIntegration(provider: string, _prev: FormState | null): Promise<FormState> {
  const r = await apiCall<{ result: { ok: boolean; detail?: string; error?: string } }>(`/api/integrations/${provider}/test`, { method: 'POST' });
  refresh();
  if (!r.ok) return stateOf(r, '');
  return r.body.result.ok ? { ok: true, message: r.body.result.detail ?? 'connected' } : { ok: false, message: r.body.result.error ?? 'failed' };
}

export async function saveBudget(_prev: FormState | null, form: FormData): Promise<FormState> {
  const raw = text(form, 'monthlyBudgetUsd');
  const value = raw === '' ? null : Number(raw);
  if (value !== null && !Number.isFinite(value)) return { ok: false, message: 'Enter a number of dollars, or leave it blank for the plan default.' };
  const r = await apiCall('/api/budget', { method: 'PUT', body: { monthlyBudgetUsd: value } });
  refresh();
  return stateOf(r, value === null ? 'Budget cleared: the plan’s included spend applies on the deployment’s key; your own key has no cap.' : `Budget set to $${value.toFixed(2)} a month.`);
}
