import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { MERGE_ACTION_ID, encodeMergeAction } from '@pager/agents';
import type { SourceControlProvider } from '@pager/providers';
import { handleSlackInteraction, type MergeEndpointDeps } from '../src/merge-endpoint.ts';

/**
 * The one endpoint that can change production. A valid Slack signature proves the
 * click came from Slack; these tests pin down that it still refuses anyone who is
 * not a named approver in the right workspace, and refuses when it cannot confirm
 * the pull request's state.
 */

const SECRET = 'test-signing-secret';
const REPO = 'acme/checkout-api';
const REVIEWED = 'a'.repeat(40);
const RESPONSE_URL = 'https://hooks.slack.com/actions/T1/1/abc';

function signedRequest(payload: object): IncomingMessage {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
  const req = Readable.from([body]) as unknown as IncomingMessage;
  req.headers = { 'x-slack-signature': sig, 'x-slack-request-timestamp': ts };
  return req;
}

function capture() {
  const out = { status: 0, body: '' };
  const res = {
    writeHead: (status: number) => {
      out.status = status;
      return res;
    },
    end: (body?: string) => {
      out.body = body ?? '';
    },
  } as unknown as ServerResponse;
  return { res, out };
}

function interaction(overrides: { team?: string; user?: string; channel?: string } = {}) {
  return {
    type: 'block_actions',
    team: { id: overrides.team ?? 'T1' },
    user: { id: overrides.user ?? 'U_APPROVER', username: 'ada' },
    channel: { id: overrides.channel ?? 'C_INCIDENTS' },
    response_url: RESPONSE_URL,
    actions: [{ action_id: MERGE_ACTION_ID, value: encodeMergeAction({ repository: REPO, pullRequest: 12, incidentKey: 'INC-1', headSha: REVIEWED }) }],
  };
}

/** Everything posted back to Slack after the acknowledgement, and the work that posted it. */
type Deps = MergeEndpointDeps & { responses: { url: string; body: { text?: string } }[]; settled: () => Promise<void> };

function deps(sourceControl: Partial<SourceControlProvider>): Deps {
  const responses: Deps['responses'] = [];
  const work: Promise<void>[] = [];
  return {
    responses,
    settled: async () => {
      await Promise.all(work);
    },
    respond: async (url, body) => {
      responses.push({ url, body: body as { text?: string } });
    },
    background: (p) => {
      work.push(p);
    },
    signingSecret: SECRET,
    enabled: true,
    autonomy: 'L4',
    repository: REPO,
    approvers: { teamId: 'T1', userIds: ['U_APPROVER'], channelId: 'C_INCIDENTS' },
    sourceControl: sourceControl as SourceControlProvider,
    approvals: [],
    log: () => {},
  };
}

const openPr = (headSha = REVIEWED) => ({ state: 'open', headSha });
const merged = () => ({ state: 'merged', headSha: REVIEWED, url: 'https://github.com/acme/checkout-api/pull/12' });

describe('Slack merge endpoint', () => {
  it('merges for a named approver in the right workspace and channel', async () => {
    const mergePullRequest = vi.fn(async () => merged());
    const { res, out } = capture();
    const d = deps({ getPullRequest: vi.fn(async () => openPr()) as never, mergePullRequest: mergePullRequest as never });
    await handleSlackInteraction(signedRequest(interaction()), res, d);
    await d.settled();
    expect(mergePullRequest).toHaveBeenCalledOnce();
    expect(out.status).toBe(200);
    expect(d.responses.at(-1)!.url).toBe(RESPONSE_URL);
    expect(d.responses.at(-1)!.body.text).toMatch(/merged by ada/);
  });

  // The merge button carried no commit, so anything pushed after the message
  // was posted merged on a click that never saw it.
  it('pins the merge to the commit that was reviewed', async () => {
    const mergePullRequest = vi.fn(async () => merged());
    const { res } = capture();
    const d = deps({ getPullRequest: vi.fn(async () => openPr()) as never, mergePullRequest: mergePullRequest as never });
    await handleSlackInteraction(signedRequest(interaction()), res, d);
    await d.settled();
    expect(mergePullRequest).toHaveBeenCalledWith(REPO, 12, expect.objectContaining({ sha: REVIEWED }));
  });

  it('refuses when the branch has moved since the message was posted', async () => {
    const mergePullRequest = vi.fn(async () => merged());
    const { res } = capture();
    const d = deps({ getPullRequest: vi.fn(async () => openPr('b'.repeat(40))) as never, mergePullRequest: mergePullRequest as never });
    await handleSlackInteraction(signedRequest(interaction()), res, d);
    await d.settled();
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(d.responses.at(-1)!.body.text).toMatch(/changed since it was reviewed/);
  });

  it('says so when GitHub refuses the pinned merge with 409', async () => {
    const { PullRequestChangedError } = await import('@pager/providers');
    const mergePullRequest = vi.fn(async () => {
      throw new PullRequestChangedError(12, REVIEWED);
    });
    const { res } = capture();
    const d = deps({ getPullRequest: vi.fn(async () => openPr()) as never, mergePullRequest: mergePullRequest as never });
    await handleSlackInteraction(signedRequest(interaction()), res, d);
    await d.settled();
    expect(d.responses.at(-1)!.body.text).toMatch(/changed since it was reviewed/);
    expect(d.approvals[0]!.outcome).toMatch(/changed since review/);
  });

  // Read, merge and re-read could outlast Slack's three seconds, and Slack then
  // shows the person an error for a merge that may have happened.
  it('acknowledges before any GitHub call returns', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const getPullRequest = vi.fn(async () => {
      await gate;
      return openPr();
    });
    const { res, out } = capture();
    const d = deps({ getPullRequest: getPullRequest as never, mergePullRequest: vi.fn(async () => merged()) as never });
    await handleSlackInteraction(signedRequest(interaction()), res, d);
    // Answered while GitHub is still pending.
    expect(out.status).toBe(200);
    expect(out.body).toMatch(/Merging #12/);
    expect(d.responses).toHaveLength(0);
    release();
    await d.settled();
    expect(d.responses.at(-1)!.body.text).toMatch(/merged by ada/);
  });

  it('never posts the outcome anywhere but Slack', async () => {
    const payload = { ...interaction(), response_url: 'https://attacker.example/hook' };
    const mergePullRequest = vi.fn(async () => merged());
    const { res, out } = capture();
    const d = deps({ getPullRequest: vi.fn(async () => openPr()) as never, mergePullRequest: mergePullRequest as never });
    await handleSlackInteraction(signedRequest(payload), res, d);
    await d.settled();
    expect(out.status).toBe(400);
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['another workspace', { team: 'T_OTHER' }, /workspace/],
    ['someone who is not an approver', { user: 'U_RANDOM' }, /not an approver/],
    ['a click outside the incident channel', { channel: 'C_ELSEWHERE' }, /outside the incident channel/],
  ])('refuses %s', async (_label, overrides, reason) => {
    const mergePullRequest = vi.fn(async () => merged());
    const { res, out } = capture();
    await handleSlackInteraction(signedRequest(interaction(overrides)), res, deps({ getPullRequest: vi.fn(async () => openPr()) as never, mergePullRequest: mergePullRequest as never }));
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(out.body).toMatch(reason);
  });

  it('refuses to merge when the pull request state cannot be read', async () => {
    const mergePullRequest = vi.fn(async () => merged());
    const d = deps({
      getPullRequest: vi.fn(async () => {
        throw new Error('GitHub 502');
      }) as never,
      mergePullRequest: mergePullRequest as never,
    });
    const { res } = capture();
    await handleSlackInteraction(signedRequest(interaction()), res, d);
    await d.settled();
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(d.responses.at(-1)!.body.text).toMatch(/could not confirm/);
    expect(d.approvals[0]?.outcome).toMatch(/^refused/);
  });
});
