/**
 * API client.
 *
 * Every fetch is uncached: an incident dashboard showing stale state is worse than
 * one that is briefly empty, because a resolved incident that still reads as
 * burning sends people to a fire that is already out.
 */
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { sessionToken } from './api-token';

const BASE = process.env.PAGER_API_URL ?? 'http://127.0.0.1:4000';

export class ApiUnavailableError extends Error {
  constructor(readonly url: string, cause: unknown) {
    super(`Could not reach the Pager Developer API at ${url}`);
    this.name = 'ApiUnavailableError';
    this.cause = cause;
  }
}

/**
 * Call the API as the signed-in member, in their workspace.
 *
 * Runs on the console's server. A missing session sends the person to sign in; an
 * API that no longer recognises the membership does the same, since it means they
 * were removed from the workspace.
 */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { res, url } = await send(path, init);
  if (!res.ok) {
    if (res.status === 404) throw new Error('not-found');
    throw new Error(`${url} responded ${res.status}`);
  }
  return (await res.json()) as T;
}

/** An API answer a form shows to the person, refusals included. */
export interface ApiResult<T> {
  ok: boolean;
  status: number;
  body: T & { error?: string; reason?: string; problems?: Record<string, string> };
}

/**
 * Like `api`, but a refusal is returned rather than thrown: forms and install
 * callbacks show the API's own reason ("the Slack bot cannot see this channel")
 * instead of a generic failure.
 */
export async function apiCall<T = Record<string, unknown>>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  const { res } = await send(path, init);
  const body = (await res.json().catch(() => ({}))) as ApiResult<T>['body'];
  return { ok: res.ok, status: res.status, body };
}

async function send(path: string, init: { method?: string; body?: unknown }): Promise<{ res: Response; url: string }> {
  const session = await auth();
  if (!session?.userId || !session.organizationId) redirect('/signin');
  const url = `${BASE}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      cache: 'no-store',
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${sessionToken(session.userId, session.organizationId)}`,
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (err) {
    throw new ApiUnavailableError(url, err);
  }
  if (res.status === 401) redirect('/signin');
  return { res, url };
}

export interface IncidentRow {
  id: string;
  key: string;
  state: string;
  severity: string;
  title: string;
  deploymentAttribution: string | null;
  attributionConfidence: number | null;
  openedAt: string;
  resolvedAt: string | null;
  slackChannel: string | null;
}

export interface DeploymentRow {
  id: string;
  commitSha: string;
  previousCommitSha: string | null;
  authorName: string | null;
  environment: string;
  status: string;
  startedAt: string;
  deployedAt: string | null;
}

export interface Overview {
  organization: { id: string; name: string; autonomyLevel: string } | null;
  incidents: IncidentRow[];
  deployments: DeploymentRow[];
  counts: {
    activeIncidents: number;
    investigating: number;
    awaitingApproval: number;
    resolved: number;
    deploymentsTracked: number;
    unattributed: number;
  };
}

export interface TimelineEvent {
  id: string;
  at: string;
  kind: string;
  summary: string;
  fromState: string | null;
  toState: string | null;
}

export interface EvidenceRow {
  id: string;
  kind: string;
  provenance: string;
  summary: string;
  sourceToolCallId: string;
  sourceRef: string | null;
  collectedAt: string;
}

export interface ToolCallRow {
  id: string;
  toolName: string;
  status: string;
  durationMs: number;
  error: string | null;
  startedAt: string;
}

export interface AgentRunRow {
  id: string;
  agentName: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  toolCalls: ToolCallRow[];
}

export interface TelemetrySnapshot {
  id: string;
  metric: string;
  windowKind: string;
  unit: string;
  sampleCount: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  points: { at: string; value: number }[];
}

/** A model's conclusion. Never rendered as though it were an observation. */
export interface InvestigationRow {
  id: string;
  suspectedRootCause: string | null;
  deploymentAttribution: string;
  attributionRationale: string | null;
  confidence: number;
  nextActions: string[];
  createdAt: string;
}

export interface HypothesisRow {
  id: string;
  status: string;
  description: string;
  confidence: number | null;
  rank: number;
}

/** A check that really ran, with the exit code of the process that ran it. */
export interface ValidationRunRow {
  id: string;
  kind: string;
  command: string;
  exitCode: number;
  passed: boolean;
  testsPassed: number | null;
  testsFailed: number | null;
  durationMs: number;
}

export interface ReproductionRow {
  id: string;
  command: string;
  environmentDescription: string;
  beforeFixExitCode: number | null;
  beforeFixPassed: boolean | null;
  afterFixExitCode: number | null;
  afterFixPassed: boolean | null;
}

export interface FixCandidateRow {
  id: string;
  branch: string;
  rootCause: string;
  explanation: string;
  risks: string[];
  rollbackPlan: string;
  confidence: number;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  files: { path: string }[];
  validation: ValidationRunRow[];
  reproduction: ReproductionRow | null;
}

export interface IncidentDetail {
  incident: IncidentRow & { serviceId: string; suspectedDeploymentId: string | null; slackThreadTs: string | null };
  service: { id: string; name: string; ownerTeam: string | null } | null;
  deployment:
    | (DeploymentRow & {
        files: { path: string; status: string; additions: number; deletions: number }[];
        commits: { sha: string; message: string; authorName: string; committedAt: string }[];
        pullRequests: { number: number; title: string; url: string }[];
      })
    | null;
  timeline: TimelineEvent[];
  evidence: EvidenceRow[];
  agentRuns: AgentRunRow[];
  auditLog: { id: string; actor: string; action: string; allowed: boolean; denialReason: string | null; at: string }[];
  telemetry: TelemetrySnapshot[];
  investigations: InvestigationRow[];
  hypotheses: HypothesisRow[];
  fixes: FixCandidateRow[];
}
