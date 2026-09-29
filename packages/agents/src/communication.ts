import { randomBytes } from 'node:crypto';
import { assertClaimSupported, type Claim, type Evidence } from '@pager/core';
import type { MessagingProvider, MessageThread } from '@pager/providers';
import type { AgentRunContext } from '@pager/observability';

/**
 * Incident communication.
 *
 * Messages are composed from structured state by the templates below, not written by
 * a model. That is deliberate: this is the surface where an unsupported claim
 * actually reaches a human, and a template cannot embellish. A model may decide
 * *what* is true; it does not get to decide how confidently that is phrased.
 *
 * Two rules hold for everything sent:
 *  - Every statement presented as fact passes the evidence gate first.
 *  - A hypothesis is phrased as one. Confidence is stated, never implied away.
 *
 * Internal reasoning is not posted. Slack gets meaningful state changes.
 */

/**
 * Slack mrkdwn escaping.
 *
 * Much of what reaches Slack came from somewhere untrusted: an exception message in
 * the logs, a commit author, a file in the repository, the model's own prose. In
 * mrkdwn, `<!channel>` pings everyone and `<https://evil|click to approve>` is a
 * disguised link, so any of those sources could post either. Slack's own rule is
 * that `&`, `<` and `>` are escaped; after that, no control sequence survives.
 *
 * Links this system builds itself are marked with `slackLink` and restored after
 * escaping, so they are the only `<…>` constructs a message can contain.
 */
// Markers carry a per-process nonce, so text from a log or a model cannot forge one.
const NONCE = randomBytes(8).toString('hex');
const LINK_OPEN = `\uE000${NONCE}`;
const LINK_SEP = `\uE001${NONCE}`;
const LINK_CLOSE = `\uE002${NONCE}`;
const LINK = new RegExp(`${LINK_OPEN}(.*?)${LINK_SEP}(.*?)${LINK_CLOSE}`, 'gs');

export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A link we built, preserved by `toSlackMrkdwn`. The label is escaped; the URL must be http(s). */
export function slackLink(url: string, label: string): string {
  if (!/^https?:\/\/[^\s<>|]+$/.test(url)) return `${label} (${url})`;
  return `${LINK_OPEN}${url}${LINK_SEP}${label.replace(/[|]/g, '/')}${LINK_CLOSE}`;
}

/** Escape a whole message, keeping only the links marked with `slackLink`. */
export function toSlackMrkdwn(text: string): string {
  return escapeMrkdwn(text).replace(LINK, (_m, url: string, label: string) => `<${url.replace(/&amp;/g, '&')}|${label}>`);
}

export interface IncidentSummary {
  key: string;
  service: string;
  severity: string;
  title: string;
}

export interface RegressionSummary {
  metric: string;
  baselineLabel: string;
  observedLabel: string;
  severity: string;
}

export interface DeploymentSummary {
  shortSha: string;
  author: string | null;
  deployedAt: Date;
  pullRequest: string | null;
}

export type AttributionVerdict =
  | 'DEPLOYMENT_LIKELY_RESPONSIBLE'
  | 'DEPLOYMENT_NOT_RESPONSIBLE'
  | 'INSUFFICIENT_EVIDENCE'
  | 'EXTERNAL_INCIDENT'
  | 'UNDER_INVESTIGATION';

const ATTRIBUTION_PHRASING: Record<AttributionVerdict, string> = {
  UNDER_INVESTIGATION: 'Under investigation',
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence to attribute',
  DEPLOYMENT_LIKELY_RESPONSIBLE: 'Deployment likely responsible',
  DEPLOYMENT_NOT_RESPONSIBLE: 'Deployment not responsible',
  EXTERNAL_INCIDENT: 'External incident — deployment not responsible',
};

export function formatOpening(
  incident: IncidentSummary,
  regression: RegressionSummary,
  deployment: DeploymentSummary | null,
  attribution: AttributionVerdict = 'UNDER_INVESTIGATION',
): string {
  const lines = [
    `:red_circle: *Production regression detected* — ${incident.key}`,
    '',
    `*Service*  ${incident.service}`,
    `*Severity*  ${incident.severity}`,
    `*${regression.metric}*  ${regression.baselineLabel} → ${regression.observedLabel}`,
  ];
  if (deployment) {
    lines.push(
      `*Recent deployment*  ${deployment.shortSha}` +
        (deployment.author ? ` by ${deployment.author}` : '') +
        (deployment.pullRequest ? ` (${deployment.pullRequest})` : ''),
    );
  }
  lines.push(
    `*Deployment attribution*  ${ATTRIBUTION_PHRASING[attribution]}`,
    '',
    'Pager Developer is investigating. No production changes have been made.',
  );
  return lines.join('\n');
}

/**
 * An investigation update.
 *
 * Hypotheses are rendered with their confidence and explicitly labelled, so a
 * reader is never left to infer how settled a statement is.
 */
export function formatInvestigationUpdate(
  facts: string[],
  hypotheses: { statement: string; confidence: number }[],
  nextAction: string | null,
): string {
  const lines = ['*Investigation update*', ''];

  if (facts.length > 0) {
    lines.push('*Established*');
    for (const f of facts) lines.push(`• ${f}`);
    lines.push('');
  }
  if (hypotheses.length > 0) {
    lines.push('*Hypotheses* _(not yet confirmed)_');
    for (const h of hypotheses) {
      lines.push(`• ${h.statement} — confidence ${(h.confidence * 100).toFixed(0)}%`);
    }
    lines.push('');
  }
  if (facts.length === 0 && hypotheses.length === 0) {
    lines.push('No conclusions yet. Investigation continues.', '');
  }
  if (nextAction) lines.push(`*Next*  ${nextAction}`);
  return lines.join('\n').trimEnd();
}

export interface VerificationSummary {
  reproduced: boolean;
  reproductionDescription: string;
  checks: { kind: string; passed: boolean; skipped: boolean; testsPassed: number | null }[];
  pullRequestUrl: string | null;
  pullRequestNumber: number | null;
}

/**
 * The fix-ready message.
 *
 * Skipped checks are listed as skipped. Reporting "all checks passed" while some
 * never ran is the precise failure this product exists to avoid, so the template
 * has no way to express it.
 */
export function formatFixReady(
  rootCause: string,
  verification: VerificationSummary,
  risks: string[],
): string {
  const lines = ['*Fix prepared*', '', `*Root cause*  ${rootCause}`, ''];

  lines.push(`*Reproduction*  ${verification.reproductionDescription}`);

  const ran = verification.checks.filter((c) => !c.skipped);
  const skipped = verification.checks.filter((c) => c.skipped);
  if (ran.length > 0) {
    lines.push('*Verification*');
    for (const c of ran) {
      const count = c.testsPassed !== null ? ` (${c.testsPassed} tests)` : '';
      lines.push(`• ${c.kind}: ${c.passed ? 'passed' : 'FAILED'}${count}`);
    }
  }
  if (skipped.length > 0) {
    lines.push(`• not run: ${skipped.map((c) => c.kind).join(', ')}`);
  }

  if (risks.length > 0) {
    lines.push('', '*Risks*');
    for (const r of risks) lines.push(`• ${r}`);
  }

  lines.push('');
  if (verification.pullRequestUrl) {
    lines.push(`*Pull request*  ${slackLink(verification.pullRequestUrl, `#${verification.pullRequestNumber}`)}`);
  }
  lines.push('*Awaiting human approval.* No production change will be made without it.');
  return lines.join('\n');
}

export function formatRecovery(
  metric: string,
  baselineLabel: string,
  incidentLabel: string,
  currentLabel: string,
  recovered: boolean,
): string {
  return [
    recovered ? ':large_green_circle: *Recovery verified*' : ':warning: *Recovery not yet verified*',
    '',
    `*${metric}*`,
    `• baseline  ${baselineLabel}`,
    `• incident  ${incidentLabel}`,
    `• now       ${currentLabel}`,
    '',
    recovered
      ? 'Signals have returned to baseline. Incident resolved.'
      : 'Signals have not returned to baseline. Continuing to monitor; the incident remains open.',
  ].join('\n');
}

export class UnsupportedCommunicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedCommunicationError';
  }
}

/**
 * Sends incident communications, gating every factual claim on evidence.
 *
 * The gate runs before the message is sent rather than after, so an unsupported
 * claim is never delivered and then retracted.
 */
export class CommunicationAgent {
  constructor(private readonly messaging: MessagingProvider) {}

  /** Verify every claim backing a message before any of it is sent. */
  private gate(claims: readonly Claim[], evidence: readonly Evidence[]): void {
    for (const claim of claims) {
      try {
        assertClaimSupported(claim, evidence);
      } catch (err) {
        throw new UnsupportedCommunicationError(
          `Refusing to send: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async openThread(
    ctx: AgentRunContext,
    channel: string,
    text: string,
    claims: readonly Claim[] = [],
    evidence: readonly Evidence[] = [],
  ): Promise<MessageThread> {
    this.gate(claims, evidence);
    const { value } = await ctx.tool('slack.openThread', { channel }, () =>
      this.messaging.openThread(channel, toSlackMrkdwn(text)),
    );
    return value;
  }

  async reply(
    ctx: AgentRunContext,
    thread: MessageThread,
    text: string,
    claims: readonly Claim[] = [],
    evidence: readonly Evidence[] = [],
  ): Promise<void> {
    this.gate(claims, evidence);
    await ctx.tool('slack.replyInThread', { channel: thread.channel, threadTs: thread.id }, () =>
      this.messaging.replyInThread(thread, toSlackMrkdwn(text)),
    );
  }

  /** Read back what was actually posted, for verifying communications. */
  async readThread(ctx: AgentRunContext, thread: MessageThread): Promise<{ text: string; at: Date }[]> {
    const { value } = await ctx.tool('slack.readThread', { channel: thread.channel }, () =>
      this.messaging.readThread(thread),
    );
    return value;
  }
}
