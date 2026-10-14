import { ActionForm } from '@/components/console/action-form';
import { addRepository, removeRepository } from '@/app/(console)/actions';
import type { ApiResult } from '@/lib/api';
import type { AvailableRepo, Installation, PickedRepo } from '@/lib/setup';

/**
 * The GitHub side of setup: where the app is installed, the repositories that
 * installation covers, and which of them this workspace watches.
 */
export function RepositoryPicker({
  installations,
  available,
  picked,
}: {
  installations: Installation[];
  available: ApiResult<{ repositories: AvailableRepo[] }>;
  picked: PickedRepo[];
}) {
  const live = installations.filter((i) => !i.removedAt);
  const pickedId = new Map(picked.map((r) => [r.fullName, r.id]));
  const install = (label: string) => (
    <a href="/onboarding/github/install" className="text-accent underline-offset-4 hover:underline">{label}</a>
  );

  if (!available.ok && available.status === 503) {
    return <p className="text-[12px] text-muted">This deployment has no GitHub App configured.</p>;
  }
  if (live.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-[12px] leading-relaxed text-muted">
          Installing the app on GitHub is what grants access, and only to the repositories you choose there. Nothing is
          merged or deployed by it.
        </p>
        <a href="/onboarding/github/install" className="inline-block bg-signal px-4 py-2 text-[12px] font-semibold text-paper hover:opacity-90">
          Install the GitHub App →
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ul className="space-y-1">
        {live.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 font-mono text-[11px] text-muted">
            <span>
              {i.accountLogin}{' '}
              <span className="text-dim">
                · {i.accountType.toLowerCase()} · {i.repositorySelection === 'all' ? 'all repositories' : 'selected repositories'}
                {i.suspendedAt ? ' · suspended' : ''}
              </span>
            </span>
            {i.settingsUrl && (
              <a href={i.settingsUrl} className="text-accent underline-offset-4 hover:underline">Add or remove repositories on GitHub →</a>
            )}
          </li>
        ))}
        <li className="pt-1 text-[11px]">{install('Install on another GitHub account or organization →')}</li>
      </ul>

      {!available.ok ? (
        <p className="text-[12px] text-muted">The installation's repositories could not be listed. {install('Install the GitHub App')} again.</p>
      ) : available.body.repositories.length === 0 ? (
        <p className="text-[12px] text-muted">The installation covers no repositories yet. Add some to it on GitHub, using the link above.</p>
      ) : (
        <ul className="divide-y divide-edge-soft border-t border-edge-soft">
          {available.body.repositories.map((r) => (
            <li key={r.fullName} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <span className="font-mono text-[12px] text-text">
                {r.fullName} <span className="text-dim">· {r.defaultBranch}{r.private ? ' · private' : ''}</span>
              </span>
              {r.picked && pickedId.get(r.fullName) ? (
                <span className="flex items-center gap-3">
                  <span className="font-mono text-[10px] text-ok">WATCHING</span>
                  <ActionForm action={removeRepository.bind(null, pickedId.get(r.fullName)!, r.fullName)} submit="Remove" tone="quiet" />
                </span>
              ) : (
                <ActionForm action={addRepository.bind(null, r.fullName)} submit="Pick" tone="quiet" />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
