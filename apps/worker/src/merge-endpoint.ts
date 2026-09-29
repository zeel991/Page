import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { SlackInteraction } from '@pager/agents';
import {
  MERGE_ACTION_ID,
  SlackSignatureError,
  assertMergeAllowed,
  decodeMergeAction,
  slackLink,
  toSlackMrkdwn,
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
 * Order matters and is deliberate: verify, then parse, then route and authorise,
 * then act. Parsing before verifying would mean running a JSON decoder on
 * unauthenticated input; authorising before verifying would mean an attacker
 * choosing the pull request number.
 *
 * One endpoint serves every workspace. A click is routed by its Slack team to the
 * one workspace that installed the app into it; it counts only from that service's
 * own channel, and only from an owner or admin of the workspace whose Slack identity
 * is linked to their membership. Nothing about who may merge is configured by name.
 *
 * Slack abandons an interaction that is not answered within three seconds, and
 * reading, merging and re-reading a pull request can take longer. So everything
 * local is decided before answering, the click is acknowledged at once, and the
 * GitHub work runs afterwards and reports back through the interaction's
 * `response_url`.
 */

export interface MergeClick {
  teamId: string | undefined;
  slackUserId: string | undefined;
  channelId: string | undefined;
  repository: string;
  pullRequest: number;
}

export type MergeRoute =
  | {
      ok: true;
      organizationId: string;
      approver: { userId: string; name: string };
      autonomy: AutonomyLevel;
      sourceControl: SourceControlProvider;
    }
  | { ok: false; reason: string; organizationId: string | null };

export interface MergeAuditEntry {
  organizationId: string | null;
  approvalId: string;
  repository: string;
  pullRequest: number;
  incidentKey: string;
  headSha: string;
  approverUserId: string | null;
  slackUserId: string | null;
  allowed: boolean;
  outcome: string;
}

/** Where a click belongs and who made it, resolved from the database. */
export interface MergeRouting {
  resolve(click: MergeClick): Promise<MergeRoute>;
  /** Every decision, allowed or refused, lands in the workspace's audit log. */
  record(entry: MergeAuditEntry): Promise<void>;
}

export interface MergeEndpointDeps {
  signingSecret: string;
  routing: MergeRouting;
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
  response.end(JSON.stringify({ response_type: 'in_channel', replace_original: false, text: toSlackMrkdwn(text) }));
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

  // 3. Route and identify. The signature proves Slack sent this; it does not prove
  //    the person may merge — anyone in the Slack team can see the message.
  const slackUserId = interaction.user?.id;
  const approvalId = randomUUID();
  const route = await deps.routing.resolve({
    teamId: interaction.team?.id ?? interaction.user?.team_id,
    slackUserId,
    channelId: interaction.channel?.id,
    repository: target.repository,
    pullRequest: target.pullRequest,
  });

  const audit = (entry: Pick<MergeAuditEntry, 'allowed' | 'outcome' | 'approverUserId'>) =>
    deps.routing
      .record({
        organizationId: route.organizationId,
        approvalId,
        repository: target.repository,
        pullRequest: target.pullRequest,
        incidentKey: target.incidentKey,
        headSha: target.headSha,
        slackUserId: slackUserId ?? null,
        ...entry,
      })
      .catch((err: unknown) => deps.log(`could not audit the merge decision: ${err instanceof Error ? err.message : String(err)}`));

  if (!route.ok) {
    deps.log(`REFUSED a merge of ${target.repository}#${target.pullRequest}: ${route.reason}`);
    await audit({ allowed: false, outcome: `refused: ${route.reason}`, approverUserId: null });
    reply(response, 200, `:no_entry: Not merged: ${route.reason}.`);
    return;
  }
  const approvedBy = route.approver.name;

  // 4. Authorise. The autonomy level is the workspace's standing grant and the click
  //    is this person's decision about this pull request; neither substitutes for
  //    the other, so both are required.
  try {
    assertMergeAllowed(route.autonomy, approvalId);
  } catch (err) {
    const reason = err instanceof PermissionDeniedError ? err.reason : 'not permitted';
    await audit({ allowed: false, outcome: `refused: ${reason}`, approverUserId: route.approver.userId });
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
  // Usernames and GitHub's error text are not ours; only our own links survive.
  const say = (text: string) => report({ response_type: 'in_channel', replace_original: false, text: toSlackMrkdwn(text) });
  const replaceWith = (lines: string[], fallback: string) =>
    report({ replace_original: true, text: toSlackMrkdwn(fallback), blocks: outcomeBlocks(lines.map(toSlackMrkdwn)) });
  const sourceControl = route.sourceControl;
  const approverUserId = route.approver.userId;

  const work = (async () => {
    // 6. Is the pull request still open, and still what was reviewed?
    try {
      const current = await sourceControl.getPullRequest(target.repository, target.pullRequest);
      if (current.state !== 'open') {
        await audit({ allowed: false, outcome: `no action: already ${current.state}`, approverUserId });
        await replaceWith(
          [`:white_check_mark: *#${target.pullRequest} is already ${current.state}.*`, `Nothing to do — someone decided this already.`],
          `#${target.pullRequest} is already ${current.state}.`,
        );
        return;
      }
      if (current.headSha !== target.headSha) {
        await audit({ allowed: false, outcome: 'refused: pull request changed since review', approverUserId });
        deps.log(`REFUSED merging #${target.pullRequest}: head moved from ${target.headSha.slice(0, 12)} to ${current.headSha.slice(0, 12)}`);
        await say(changedSinceReview(target.pullRequest));
        return;
      }
    } catch (err) {
      // Fail closed. Without knowing the pull request's current state, merging could
      // act on something already closed or reopened with new commits.
      const message = err instanceof Error ? err.message : String(err);
      await audit({ allowed: false, outcome: `refused: could not read the pull request (${message})`, approverUserId });
      deps.log(`REFUSED merging #${target.pullRequest}: could not read its state: ${message}`);
      await say(`:warning: Not merged: could not confirm the current state of #${target.pullRequest}. Try again, or merge on GitHub.`);
      return;
    }

    // 7. Act, pinned to the reviewed commit.
    try {
      const merged = await sourceControl.mergePullRequest(target.repository, target.pullRequest, {
        method: 'squash',
        commitTitle: `${target.incidentKey}: merged by ${approvedBy} via Pager Developer`,
        sha: target.headSha,
      });
      await audit({ allowed: true, outcome: merged.state === 'merged' ? 'merged' : `not merged (${merged.state})`, approverUserId });
      deps.log(`#${target.pullRequest} merged by ${approvedBy} — approval ${approvalId}`);
      await replaceWith(
        [
          `:white_check_mark: *#${target.pullRequest} merged by ${approvedBy}.*`,
          `Approval \`${approvalId}\` recorded against them. Pager Developer did not decide this.`,
          slackLink(merged.url, 'View the pull request'),
        ],
        `#${target.pullRequest} merged by ${approvedBy}.`,
      );
    } catch (err) {
      if (err instanceof PullRequestChangedError) {
        await audit({ allowed: false, outcome: 'refused: pull request changed since review', approverUserId });
        await say(changedSinceReview(target.pullRequest));
        return;
      }
      // GitHub answers 405 when its own rules refuse the merge — conflicts, a failing
      // required check, branch protection. Surfaced as-is: that is a decision by the
      // repository, not a transient error to retry around.
      const message = err instanceof Error ? err.message : String(err);
      await audit({ allowed: false, outcome: `merge failed: ${message}`, approverUserId });
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
