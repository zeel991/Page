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
    actions: [{ action_id: MERGE_ACTION_ID, value: encodeMergeAction({ repository: REPO, pullRequest: 12, incidentKey: 'INC-1' }) }],
  };
}

function deps(sourceControl: Partial<SourceControlProvider>): MergeEndpointDeps {
  return {
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

const openPr = () => ({ state: 'open' });
const merged = () => ({ state: 'merged', url: 'https://github.com/acme/checkout-api/pull/12' });

describe('Slack merge endpoint', () => {
  it('merges for a named approver in the right workspace and channel', async () => {
    const mergePullRequest = vi.fn(async () => merged());
    const { res, out } = capture();
    await handleSlackInteraction(signedRequest(interaction()), res, deps({ getPullRequest: vi.fn(async () => openPr()) as never, mergePullRequest: mergePullRequest as never }));
    expect(mergePullRequest).toHaveBeenCalledOnce();
    expect(out.status).toBe(200);
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
    const { res, out } = capture();
    await handleSlackInteraction(signedRequest(interaction()), res, d);
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect(out.body).toMatch(/could not confirm/);
    expect(d.approvals[0]?.outcome).toMatch(/^refused/);
  });
});
