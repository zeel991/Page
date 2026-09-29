import { describe, expect, it } from 'vitest';
import type { CommitComparison, PullRequest } from '@pager/providers';
import { decideRecoveryWindow } from '../src/recovery-window.ts';

const MERGED_AT = new Date('2026-09-13T15:00:00Z');
const minutes = (n: number) => new Date(MERGED_AT.getTime() + n * 60_000);

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 12,
  title: 't',
  body: '',
  headRef: 'pager/inc-1',
  baseRef: 'main',
  url: 'https://github.test/pull/12',
  state: 'merged',
  mergeCommitSha: 'merge0000000000000000000000000000000000',
  headSha: 'head00000000000000000000000000000000000',
  mergedAt: MERGED_AT,
  ...over,
});

function run(opts: {
  now: Date;
  deployedAt?: Date | null;
  deployed?: string | null;
  relation?: CommitComparison['status'];
  pullRequest?: PullRequest;
}) {
  let probes = 0;
  return {
    decision: decideRecoveryWindow({
      repository: 'acme/checkout-api',
      pullRequest: opts.pullRequest ?? pr(),
      deployedAt: opts.deployedAt ?? null,
      now: opts.now,
      probe: async () => {
        probes++;
        return { sha: opts.deployed ?? null, problem: opts.deployed ? null : 'health endpoint returned 503' };
      },
      sourceControl: {
        compareCommits: async () => ({ status: opts.relation ?? 'identical', aheadBy: 0, behindBy: 0 }),
      },
    }),
    probes: () => probes,
  };
}

describe('decideRecoveryWindow', () => {
  it('waits while the deployed revision does not yet contain the merge', async () => {
    const d = await run({ now: minutes(5), deployed: 'old0000', relation: 'behind' }).decision;
    expect(d.kind).toBe('wait');
    if (d.kind === 'wait') expect(d.deployedAt).toBeNull();
  });

  it('starts the window when the merge commit is first seen deployed', async () => {
    const d = await run({ now: minutes(7), deployed: 'merge00', relation: 'identical' }).decision;
    // Seen now; the window is still open, so it waits and remembers when.
    expect(d).toMatchObject({ kind: 'wait', deployedAt: minutes(7) });
  });

  it('accepts a deployed revision that descends from the merge', async () => {
    const d = await run({ now: minutes(7), deployed: 'later00', relation: 'ahead' }).decision;
    expect(d).toMatchObject({ kind: 'wait', deployedAt: minutes(7) });
  });

  it('measures fifteen minutes from the deploy, not from the pull request', async () => {
    // A merge noticed an hour after the PR opened: the old code measured a window
    // fixed at PR-open time, i.e. the incident's own traffic.
    const t = run({ now: minutes(40), deployedAt: minutes(20) });
    const d = await t.decision;
    expect(d).toEqual({ kind: 'ready', window: { from: minutes(20), to: minutes(35) } });
    expect(t.probes()).toBe(0);
  });

  it('never starts before the merge', async () => {
    const d = await run({ now: minutes(30), deployedAt: minutes(-10) }).decision;
    expect(d).toEqual({ kind: 'ready', window: { from: MERGED_AT, to: minutes(15) } });
  });

  it('gives up with a reason when the fix never reaches production', async () => {
    const d = await run({ now: minutes(61), deployed: 'old0000', relation: 'behind' }).decision;
    expect(d.kind).toBe('unavailable');
    if (d.kind === 'unavailable') {
      expect(d.reason).toMatch(/not observed in the deployed revision within 60 minutes/);
      expect(d.reason).toMatch(/behind relative to the merge commit/);
    }
  });

  it('says what the probe said when the service could not report', async () => {
    const d = await run({ now: minutes(61), deployed: null }).decision;
    expect(d.kind === 'unavailable' && d.reason).toMatch(/503/);
  });

  it('refuses to guess a window when GitHub gave no merge time', async () => {
    const d = await run({ now: minutes(30), pullRequest: pr({ mergedAt: null }) }).decision;
    expect(d.kind).toBe('unavailable');
  });
});
