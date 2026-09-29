import type { PullRequest, SourceControlProvider, TimeRange } from '@pager/providers';

/**
 * When does post-fix traffic begin?
 *
 * Not when the pull request was opened, and not quite when it was merged: a merge
 * changes the branch, and production changes only when that branch is deployed.
 * Measuring from the merge would count the minutes between merge and deploy as
 * "after the fix" when the broken code was still serving them. So the window opens
 * when the service first reports a revision that contains the merge commit, and
 * the merge time is only a lower bound.
 *
 * The deployed revision is observed on a poll, so the start is the first poll that
 * saw it — later than the real deploy by up to one interval. Starting late only
 * drops post-fix traffic; it never includes pre-fix traffic.
 */

export const RECOVERY_WINDOW_MS = 15 * 60_000;
/** How long after a merge to keep waiting for it to reach production. */
export const DEPLOY_WAIT_BOUND_MS = 60 * 60_000;

export type RecoveryWindowDecision =
  /** Not measurable yet. `deployedAt` is what to remember for the next check. */
  | { kind: 'wait'; reason: string; deployedAt: Date | null }
  | { kind: 'ready'; window: TimeRange }
  | { kind: 'unavailable'; reason: string };

export interface RecoveryWindowInput {
  repository: string;
  pullRequest: PullRequest;
  /** When a deployed revision containing the merge was first seen, if it has been. */
  deployedAt: Date | null;
  now: Date;
  /** The revision production reports now. Called only while `deployedAt` is unknown. */
  probe: () => Promise<{ sha: string | null; problem: string | null }>;
  sourceControl: Pick<SourceControlProvider, 'compareCommits'>;
  windowMs?: number;
  deployBoundMs?: number;
}

export async function decideRecoveryWindow(input: RecoveryWindowInput): Promise<RecoveryWindowDecision> {
  const windowMs = input.windowMs ?? RECOVERY_WINDOW_MS;
  const boundMs = input.deployBoundMs ?? DEPLOY_WAIT_BOUND_MS;
  const pr = input.pullRequest;

  if (!pr.mergedAt || !pr.mergeCommitSha) {
    return {
      kind: 'unavailable',
      reason: `GitHub did not report ${!pr.mergedAt ? 'when' : 'which commit'} #${pr.number} merged, so no post-fix window can be placed.`,
    };
  }

  let deployedAt = input.deployedAt;
  let lastSeen = 'not yet checked';
  if (!deployedAt) {
    const probe = await input.probe();
    if (probe.sha) {
      lastSeen = `deployed revision ${probe.sha.slice(0, 12)}`;
      try {
        const relation = await input.sourceControl.compareCommits(input.repository, pr.mergeCommitSha, probe.sha);
        // `ahead`: the deployed revision descends from the merge. Either way it contains the fix.
        if (relation.status === 'identical' || relation.status === 'ahead') deployedAt = input.now;
        else lastSeen += ` (${relation.status} relative to the merge commit)`;
      } catch (err) {
        lastSeen += ` (ancestry unknown: ${err instanceof Error ? err.message : String(err)})`;
      }
    } else {
      lastSeen = probe.problem ?? 'the service reported no revision';
    }
  }

  if (!deployedAt) {
    const waited = input.now.getTime() - pr.mergedAt.getTime();
    if (waited > boundMs) {
      return {
        kind: 'unavailable',
        reason:
          `the merge commit ${pr.mergeCommitSha.slice(0, 12)} was not observed in the deployed revision within ` +
          `${Math.round(boundMs / 60_000)} minutes of the merge (last seen: ${lastSeen}), so there is no post-fix traffic to measure.`,
      };
    }
    return { kind: 'wait', reason: `#${pr.number} is merged but not yet deployed (${lastSeen}).`, deployedAt: null };
  }

  // Never before the merge, even if a clock disagrees.
  const from = new Date(Math.max(deployedAt.getTime(), pr.mergedAt.getTime()));
  const to = new Date(from.getTime() + windowMs);
  if (input.now.getTime() < to.getTime()) {
    return {
      kind: 'wait',
      reason: `#${pr.number} is deployed; measuring post-fix traffic until ${to.toISOString()}.`,
      deployedAt,
    };
  }
  return { kind: 'ready', window: { from, to } };
}
