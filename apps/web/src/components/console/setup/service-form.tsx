import { ActionForm } from '@/components/console/action-form';
import { Field, INPUT } from '@/components/console/fields';
import { createService } from '@/app/(console)/actions';
import type { ApiResult } from '@/lib/api';
import type { Channel, PickedRepo } from '@/lib/setup';

/** L0 and L1 cannot report to Slack; the API refuses them. L5 is not offered from the console. */
export const LEVELS = [
  ['L2', 'Prepare a fix in a sandbox and report it. No pull request.'],
  ['L3', 'Open a pull request. A person merges it. The default.'],
  ['L4', 'Also offer a Merge button in Slack, pinned to the validated commit, for an owner or admin to press.'],
] as const;

/** The form that creates a watched service. Its prerequisites are stated, not discovered by a refused save. */
export function ServiceForm({
  picked,
  channels,
  alerts,
  compact = false,
}: {
  picked: PickedRepo[];
  channels: ApiResult<{ channels: Channel[] }>;
  alerts: { datadog: boolean; sentry: boolean };
  compact?: boolean;
}) {
  const missing: string[] = [];
  if (picked.length === 0) missing.push('a picked repository');
  if (!alerts.datadog && !alerts.sentry) missing.push('Datadog or Sentry');
  if (!channels.ok) missing.push('Slack');
  if (missing.length > 0) {
    return <p className="text-[12px] text-muted">Needs {missing.join(', ')} first. The steps above cover each.</p>;
  }
  const defaultSource = alerts.datadog ? 'datadog' : 'sentry';
  return (
    <ActionForm action={createService} submit="Save and start watching" className="grid max-w-3xl gap-4 md:grid-cols-2">
      <Field label="Service name" hint="Its Datadog service tag, or its Sentry project slug.">
        <input name="name" required className={INPUT} placeholder="checkout-api" />
      </Field>
      <Field label="Repository">
        <select name="repositoryId" required className={INPUT}>
          {picked.map((r) => (
            <option key={r.id} value={r.id}>{r.fullName}</option>
          ))}
        </select>
      </Field>
      <Field label="Health URL" hint="https. Must report the deployed commit, as JSON (sha, commit, revision or version).">
        <input name="healthUrl" type="url" required className={INPUT} placeholder="https://checkout.example.com/health" />
      </Field>
      <Field label="Slack channel" hint="Merge clicks count only from this channel. Invite the bot to a private one first.">
        <select name="slackChannel" required className={INPUT}>
          {channels.ok &&
            channels.body.channels.map((c) => (
              <option key={c.id} value={`${c.id}|${c.name}`}>
                #{c.name}{c.isPrivate ? ' (private)' : ''}{c.isMember ? '' : ' — bot not in channel'}
              </option>
            ))}
        </select>
      </Field>
      <Field label="Alerts from" hint="Datadog: the service's monitors, by its service tag. Sentry: new and regressed issues in the project whose slug is the service name.">
        <select name="alertSource" defaultValue={defaultSource} className={INPUT}>
          {alerts.datadog && <option value="datadog">Datadog monitors</option>}
          {alerts.sentry && <option value="sentry">Sentry issues</option>}
        </select>
      </Field>
      <Field label="Autonomy">
        <select name="autonomyLevel" defaultValue="L3" className={INPUT}>
          {LEVELS.map(([level, meaning]) => (
            <option key={level} value={level}>{level} — {meaning}</option>
          ))}
        </select>
      </Field>
      {!compact && (
        <>
          <Field label="Poll interval (seconds)" hint="15 to 3600.">
            <input name="intervalSeconds" type="number" min={15} max={3600} defaultValue={60} className={INPUT} />
          </Field>
          <Field label="Base branch" hint="Blank: the repository's default branch.">
            <input name="baseBranch" className={INPUT} placeholder="main" />
          </Field>
          <Field label="Email the write-up to" hint="Optional, comma-separated. Needs Resend in Settings.">
            <input name="emailRecipients" className={INPUT} placeholder="oncall@example.com" />
          </Field>
          <Field label="Notion parent page id" hint="Optional. Needs Notion in Settings.">
            <input name="notionParentPageId" className={INPUT} />
          </Field>
        </>
      )}
      <label className="flex items-center gap-2 self-end text-[12px] text-muted">
        <input type="checkbox" name="readOnly" /> Read-only: investigate and report, never write to the repository
      </label>
    </ActionForm>
  );
}
