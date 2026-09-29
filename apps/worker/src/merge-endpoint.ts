import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { SlackInteraction } from '@pager/agents';
import {
  MERGE_ACTION_ID,
  SlackSignatureError,
  assertMergeAllowed,
  decodeMergeAction,
  verifySlackSignature,
} from '@pager/agents';
import { PermissionDeniedError, type AutonomyLevel } from '@pager/core';
import { PullRequestChangedError, type SourceControlProvider } from '@pager/providers';

/**
 * The Slack interaction that merges a pull request.
 *
 * The agent never decides to merge. A person decides, in Slack, and this executes
 * the decision they recorded — which is only meaningful if the request carrying it
 * is really theirs, so nothing here trusts the payload until the signature checks
 * out.
 *
 * Order matters and is deliberate: verify, then parse, then authorise, then act.
 * Parsing before verifying would mean running a JSON decoder on unauthenticated
 * input; authorising before verifying would mean an attacker choosing the pull
 * request number.
 *
 * Slack abandons an interaction that is not answered within three seconds, and
 * reading, merging and re-reading a pull request can take longer. So everything
 * local is decided before answering, the click is acknowledged at once, and the
 * GitHub work runs afterwards and reports back through the interaction's
 * `response_url`.
 */

export interface MergeApproval {
  id: string;
  repository: string;
  pullRequest: number;
  incidentKey: string;
  approvedBy: string;
  decidedAt: string;
  outcome: string;
}

export interface MergeEndpointDeps {
  signingSecret: string;
  enabled: boolean;
  /** The operator's standing grant. Merging refuses below L4. */
  autonomy: AutonomyLevel;
  repository: string;
  /** Only these people, in this workspace (and channel, when set), may merge. */
  approvers: { teamId: string; userIds: readonly string[]; channelId: string | null };
  sourceControl: SourceControlProvider;
  /** Recorded approvals, newest first. Shown on the dashboard. */
  approvals: MergeApproval[];
  log: (message: string) => void;
  /** Posts a follow-up to Slack's response_url. Defaults to an HTTPS POST. */
  respond?: (responseUrl: string, body: object) => Promise<void>;
  /** Runs the work that happens after the acknowledgement. Injected in tests. */
  background?: (work: Promise<void>) => void;
}

/** Slack's response URLs live here; nothing else is posted to. */
const RESPONSE_URL = /^https:\/\/hooks\.slack\.com\//;

async function postToResponseUrl(responseUrl: string, body: object): Promise<void> {
  const res = await fetch(responseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Slack response_url answered ${res.status}`);
}

async function readBody(request: IncomingMessage, maxBytes = 256_000): Promise<string> {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > maxBytes) throw new Error('request body too large');
  }
  return body;
}

function reply(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ response_type: 'in_channel', replace_original: false, text }));
}

/**
 * The message the button lived on is replaced once a decision is taken.
 *
 * Once a pull request is merged the button is not merely useless, it is misleading:
 * it invites a click that can only fail, and it leaves the channel showing an
 * outstanding decision that was in fact taken. The outcome replaces the offer.
 */
function outcomeBlocks(lines: string[]): unknown[] {
  return [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }];
}

export async function handleSlackInteraction(
  request: IncomingMessage,
  response: ServerResponse,
  deps: MergeEndpointDeps,
): Promise<void> {
  if (!deps.enabled) {
    // Refused rather than ignored: a 404 here would look like a misconfigured URL
    // when the truth is that this deployment deliberately does not offer merging.
    reply(response, 403, 'This Pager Developer deployment does not offer merging from Slack.');
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readBody(request);
  } catch {
    reply(response, 413, 'Request body too large.');
    return;
  }

  // 1. Verify — before the payload is parsed, let alone believed.
  try {
    verifySlackSignature({
      signingSecret: deps.signingSecret,
      signature: request.headers['x-slack-signature'] as string | undefined,
      timestamp: request.headers['x-slack-request-timestamp'] as string | undefined,
      rawBody,
    });
  } catch (err) {
    const reason = err instanceof SlackSignatureError ? err.message : 'signature could not be verified';
    deps.log(`REFUSED a Slack interaction: ${reason}`);
    reply(response, 401, 'Could not verify that this request came from Slack.');
    return;
  }

  // 2. Parse.
  let interaction: SlackInteraction;
  try {
    const encoded = new URLSearchParams(rawBody).get('payload');
    if (!encoded) throw new Error('no payload field');
    interaction = JSON.parse(encoded) as SlackInteraction;
  } catch {
    reply(response, 400, 'Could not read the interaction payload.');
    return;
  }

  const action = (interaction.actions ?? []).find((a) => a.action_id === MERGE_ACTION_ID);
  if (!action) {
    // Another button on the same message, or a Slack event we do not handle.
    reply(response, 200, '');
    return;
  }

  let target;
  try {
    target = decodeMergeAction(action.value);
  } catch {
    reply(response, 400, 'That button carried an action this deployment does not recognise.');
    return;
  }

  // 3. The approval is scoped to exactly one pull request in one repository, and
  //    the repository is the one this worker watches — not one named by the payload.
  if (target.repository !== deps.repository) {
    deps.log(`REFUSED a merge for ${target.repository}: this worker watches ${deps.repository}`);
    reply(response, 403, `This worker does not watch ${target.repository}.`);
    return;
  }

  // 3b. Who is asking. The signature proves Slack sent this; it does not prove the
  //     person may merge — anyone in the workspace can see the message. So the click
  //     counts only from the configured workspace, channel and named approvers.
  const teamId = interaction.team?.id ?? interaction.user?.team_id;
  const userId = interaction.user?.id;
  const refusal =
    teamId !== deps.approvers.teamId
      ? `workspace ${teamId ?? 'unknown'} is not the one this worker serves`
      : deps.approvers.channelId && interaction.channel?.id !== deps.approvers.channelId
        ? `the button was pressed outside the incident channel`
        : !userId || !deps.approvers.userIds.includes(userId)
          ? `${userId ?? 'an unknown user'} is not an approver for this worker`
          : null;
  if (refusal) {
    deps.log(`REFUSED a merge of ${target.repository}#${target.pullRequest}: ${refusal}`);
    reply(response, 200, `:no_entry: Not merged: ${refusal}.`);
    return;
  }

  const approvedBy = interaction.user?.username ?? interaction.user?.name ?? interaction.user?.id ?? 'unknown';
  const approval: MergeApproval = {
    id: randomUUID(),
    repository: target.repository,
    pullRequest: target.pullRequest,
    incidentKey: target.incidentKey,
    approvedBy,
    decidedAt: new Date().toISOString(),
    outcome: 'approved',
  };

  // 4. Authorise. The autonomy level is the operator's standing grant and the
  //    approval is this person's decision about this pull request; neither
  //    substitutes for the other, so both are required. Local, so it is decided
  //    before the acknowledgement.
  try {
    assertMergeAllowed(deps.autonomy, approval.id);
  } catch (err) {
    approval.outcome = `refused: ${err instanceof PermissionDeniedError ? err.reason : 'not permitted'}`;
    deps.approvals.unshift(approval);
    reply(response, 403, `Refused: ${err instanceof Error ? err.message : 'not permitted'}`);
    return;
  }

  const responseUrl = interaction.response_url;
  if (!responseUrl || !RESPONSE_URL.test(responseUrl)) {
    // Without somewhere to report the outcome, nobody would learn whether it merged.
    reply(response, 400, 'This interaction carried no Slack response URL to report back to.');
    return;
  }

  // 5. Acknowledge now; Slack gives up after three seconds.
  reply(response, 200, `:hourglass_flowing_sand: Merging #${target.pullRequest} for ${approvedBy}…`);

  const send = deps.respond ?? postToResponseUrl;
  const report = (body: object) =>
    send(responseUrl, body).catch((err: unknown) => {
      deps.log(`could not report the merge outcome to Slack: ${err instanceof Error ? err.message : String(err)}`);
    });
  const say = (text: string) => report({ response_type: 'in_channel', replace_original: false, text });
  const replaceWith = (lines: string[], fallback: string) =>
    report({ replace_original: true, text: fallback, blocks: outcomeBlocks(lines) });

  const work = (async () => {
    // 6. Is the pull request still open, and still what was reviewed? A message stays
    //    in the channel long after the decision it offered was taken, and clicking an
    //    old one must not be an error the person has to interpret.
    try {
      const current = await deps.sourceControl.getPullRequest(target.repository, target.pullRequest);
      if (current.state !== 'open') {
        approval.outcome = `no action: already ${current.state}`;
        deps.approvals.unshift(approval);
        await replaceWith(
          [
            `:white_check_mark: *#${target.pullRequest} is already ${current.state}.*`,
            `Nothing to do — someone decided this already.`,
          ],
          `#${target.pullRequest} is already ${current.state}.`,
        );
        return;
      }
      if (current.headSha !== target.headSha) {
        approval.outcome = 'refused: pull request changed since review';
        deps.approvals.unshift(approval);
        deps.log(`REFUSED merging #${target.pullRequest}: head moved from ${target.headSha.slice(0, 12)} to ${current.headSha.slice(0, 12)}`);
        await say(changedSinceReview(target.pullRequest));
        return;
      }
    } catch (err) {
      // Fail closed. Without knowing the pull request's current state, merging could
      // act on something already closed or reopened with new commits.
      const message = err instanceof Error ? err.message : String(err);
      approval.outcome = `refused: could not read the pull request (${message})`;
      deps.approvals.unshift(approval);
      deps.log(`REFUSED merging #${target.pullRequest}: could not read its state: ${message}`);
      await say(`:warning: Not merged: could not confirm the current state of #${target.pullRequest}. Try again, or merge on GitHub.`);
      return;
    }

    // 7. Act, pinned to the reviewed commit.
    try {
      const merged = await deps.sourceControl.mergePullRequest(target.repository, target.pullRequest, {
        method: 'squash',
        commitTitle: `${target.incidentKey}: merged by ${approvedBy} via Pager Developer`,
        sha: target.headSha,
      });
      approval.outcome = merged.state === 'merged' ? 'merged' : `not merged (${merged.state})`;
      deps.approvals.unshift(approval);
      deps.log(`#${target.pullRequest} merged by ${approvedBy} — approval ${approval.id}`);
      // The button is gone: the offer has been taken, and leaving it would invite a
      // click that can only fail.
      await replaceWith(
        [
          `:white_check_mark: *#${target.pullRequest} merged by ${approvedBy}.*`,
          `Approval \`${approval.id}\` recorded against them. Pager Developer did not decide this.`,
          `<${merged.url}|View the pull request>`,
        ],
        `#${target.pullRequest} merged by ${approvedBy}.`,
      );
    } catch (err) {
      if (err instanceof PullRequestChangedError) {
        approval.outcome = 'refused: pull request changed since review';
        deps.approvals.unshift(approval);
        deps.log(`merge of #${target.pullRequest} refused by GitHub: head changed since review`);
        await say(changedSinceReview(target.pullRequest));
        return;
      }
      // GitHub answers 405 when its own rules refuse the merge — conflicts, a failing
      // required check, branch protection. Surfaced as-is: that is a decision by the
      // repository, not a transient error to retry around.
      const message = err instanceof Error ? err.message : String(err);
      approval.outcome = `merge failed: ${message}`;
      deps.approvals.unshift(approval);
      deps.log(`merge of #${target.pullRequest} failed: ${message}`);
      await say(`:x: Could not merge #${target.pullRequest}: ${message}`);
    }
  })();

  (deps.background ?? ((p) => void p.catch((err: unknown) => deps.log(`merge work failed: ${String(err)}`))))(work);
}

function changedSinceReview(pullRequest: number): string {
  return (
    `:warning: Not merged: #${pullRequest} changed since it was reviewed — commits were pushed after ` +
    `this message was posted, and nobody has approved them. Review the new head on GitHub.`
  );
}
