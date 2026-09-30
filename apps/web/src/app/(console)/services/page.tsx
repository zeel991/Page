import Link from 'next/link';
import { api, apiCall } from '@/lib/api';
import { Empty, PageHeader, Panel, dateOf } from '@/components/ui';
import { ActionForm } from '@/components/console/action-form';
import { Field, INPUT } from '@/components/console/fields';
import { addRepository, createService, setWatching, testHealth } from '../actions';

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

interface AvailableRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  picked: boolean;
}

interface Channel {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

/** L0 and L1 cannot report to Slack; the API refuses them. L5 is not offered from the console. */
const LEVELS = [
  ['L2', 'Prepare a fix in a sandbox and report it. No pull request.'],
  ['L3', 'Open a pull request. A person merges it. The default.'],
  ['L4', 'Also offer a Merge button in Slack, pinned to the validated commit, for an owner or admin to press.'],
] as const;

export default async function ServicesPage() {
  const [{ services }, { repositories: picked }, available, channels, onboarding] = await Promise.all([
    api<{ services: ServiceRow[] }>('/api/services'),
    api<{ repositories: { id: string; fullName: string; defaultBranch: string }[] }>('/api/repositories'),
    apiCall<{ repositories: AvailableRepo[] }>('/api/github/repositories'),
    apiCall<{ channels: Channel[] }>('/api/slack/channels'),
    api<{ plan: { plan: { name: string }; services: { used: number; limit: number } } }>('/api/onboarding'),
  ]);
  const watched = services.filter((s) => s.alertSource !== 'sample');
  const samples = services.filter((s) => s.alertSource === 'sample');
  const repoName = new Map(picked.map((r) => [r.id, r.fullName]));
  const { used, limit } = onboarding.plan.services;
  const atLimit = used >= limit;

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="What it watches" title="Services" meta={`${used} of ${limit} on the ${onboarding.plan.plan.name} plan`} />

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
                <div className="mt-2 flex flex-wrap gap-4">
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
          {!available.ok ? (
            <p className="text-[12px] text-muted">
              {available.status === 503 ? (
                'This deployment has no GitHub App configured.'
              ) : (
                <>
                  <a href="/onboarding/github/install" className="text-accent underline-offset-4 hover:underline">Install the GitHub App</a> to list repositories.
                </>
              )}
            </p>
          ) : available.body.repositories.length === 0 ? (
            <p className="text-[12px] text-muted">
              No installation yet, or it covers no repositories.{' '}
              <a href="/onboarding/github/install" className="text-accent underline-offset-4 hover:underline">Install the GitHub App</a>, or add repositories to it on GitHub.
            </p>
          ) : (
            <ul className="divide-y divide-edge-soft">
              {available.body.repositories.map((r) => (
                <li key={r.fullName} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <span className="font-mono text-[12px] text-text">
                    {r.fullName} <span className="text-dim">· {r.defaultBranch}{r.private ? ' · private' : ''}</span>
                  </span>
                  {r.picked ? (
                    <span className="font-mono text-[10px] text-ok">PICKED</span>
                  ) : (
                    <ActionForm action={addRepository.bind(null, r.fullName)} submit="Pick" tone="quiet" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </section>

      <section id="new">
        <Panel title="Add a service" subtitle={atLimit ? `the ${onboarding.plan.plan.name} plan's ${limit} service(s) are used` : 'watched from the moment it is saved; test its health URL first'}>
          {atLimit ? (
            <p className="text-[12px] text-muted">This workspace is at its plan&apos;s service limit. Paid plans are not yet available.</p>
          ) : picked.length === 0 ? (
            <p className="text-[12px] text-muted">Pick a repository above first.</p>
          ) : (
            <ActionForm action={createService} submit="Save service" className="grid max-w-3xl gap-4 md:grid-cols-2">
              <Field label="Service name" hint="As Datadog knows it: the value of its service tag.">
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
              <Field
                label="Slack channel"
                hint={channels.ok ? 'Merge clicks count only from this channel. Invite the bot to a private one first.' : undefined}
              >
                {channels.ok ? (
                  <select name="slackChannel" required className={INPUT}>
                    {channels.body.channels.map((c) => (
                      <option key={c.id} value={`${c.id}|${c.name}`}>
                        #{c.name}{c.isPrivate ? ' (private)' : ''}{c.isMember ? '' : ' — bot not in channel'}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="py-2 text-[12px] text-muted">
                    <a href="/onboarding/slack/install" className="text-accent underline-offset-4 hover:underline">Connect Slack</a> to pick a channel.
                  </p>
                )}
              </Field>
              <Field label="Autonomy">
                <select name="autonomyLevel" defaultValue="L3" className={INPUT}>
                  {LEVELS.map(([level, meaning]) => (
                    <option key={level} value={level}>{level} — {meaning}</option>
                  ))}
                </select>
              </Field>
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
              <label className="flex items-center gap-2 self-end text-[12px] text-muted">
                <input type="checkbox" name="readOnly" /> Read-only: investigate and report, never write to the repository
              </label>
            </ActionForm>
          )}
          <p className="mt-4 text-[11px] text-dim">
            Alerts come from Datadog — connect it in <Link href="/settings#datadog" className="text-accent underline-offset-4 hover:underline">Settings</Link>.
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
