import {
  InvalidTransitionError,
  assertTransition,
  isTerminal,
  type IncidentState,
} from '@pager/core';
import {
  isUniqueViolation,
  type AuditRepository,
  type IncidentRepositories,
  type IncidentRepository,
  type IncidentRow,
  type IncidentUnitOfWork,
  type TimelineRepository,
} from '@pager/db';

/**
 * The incident engine.
 *
 * Owns every state change. Agents propose transitions; this decides whether they are
 * legal and records what happened. Nothing else is permitted to write
 * `incidents.state`, which is what keeps the state machine from becoming decorative.
 *
 * Three things happen together on every transition, in this order:
 *   1. the transition is validated against the allow-list
 *   2. the incident row is updated
 *   3. the timeline gains an entry
 *
 * A rejected transition still produces an audit record. An agent repeatedly trying to
 * jump straight to RESOLVED is exactly the behaviour an operator needs to see, and
 * silently refusing would hide it.
 */

export interface TransitionInput {
  to: IncidentState;
  /** Human-readable reason. Appears on the incident timeline. */
  summary: string;
  agentRunId?: string | null;
  detail?: Record<string, unknown>;
  actor?: string;
}

/** Attempts to allocate an incident key before giving up on a contended organisation. */
const KEY_ATTEMPTS = 5;

export class IncidentEngine {
  /**
   * @param unitOfWork When given — and it should be, against a real database —
   *   every transition runs in one transaction with the incident row locked, so two
   *   concurrent transitions cannot both validate against the same old state.
   */
  constructor(
    private readonly incidents: IncidentRepository,
    private readonly timeline: TimelineRepository,
    private readonly audit: AuditRepository,
    private readonly unitOfWork?: IncidentUnitOfWork,
  ) {}

  async open(input: {
    organizationId: string;
    serviceId: string;
    title: string;
    severity: 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4';
    suspectedDeploymentId?: string | null;
    keyPrefix?: string;
  }): Promise<IncidentRow> {
    // Keys are allocated as max+1, so two incidents opened at once can pick the same
    // one; the unique (organization, key) index refuses the second, which retries.
    let incident: IncidentRow | undefined;
    for (let attempt = 1; !incident; attempt++) {
      const key = await this.incidents.nextKey(input.organizationId, input.keyPrefix);
      try {
        incident = await this.incidents.create({
          organizationId: input.organizationId,
          serviceId: input.serviceId,
          key,
          title: input.title,
          severity: input.severity,
          state: 'INCIDENT_OPEN',
          suspectedDeploymentId: input.suspectedDeploymentId ?? null,
          // Deliberately null. A deployment being suspected is not an attribution, and
          // leaving this unset until Phase 3 produces evidence is the whole point.
          deploymentAttribution: null,
        });
      } catch (err) {
        if (!isUniqueViolation(err) || attempt >= KEY_ATTEMPTS) throw err;
      }
    }
    if (!incident) throw new Error('no incident key could be allocated');

    await this.timeline.append({
      incidentId: incident.id,
      kind: 'incident_opened',
      summary: input.title,
      toState: 'INCIDENT_OPEN',
      detail: { severity: input.severity },
    });

    return incident;
  }

  /** Apply a state transition, or throw and audit the refusal. */
  async transition(incidentId: string, input: TransitionInput): Promise<IncidentRow> {
    const outcome = this.unitOfWork
      ? await this.unitOfWork((repos) => this.applyTransition(repos, incidentId, input, true))
      : await this.applyTransition(
          { incidents: this.incidents, timeline: this.timeline, audit: this.audit },
          incidentId,
          input,
          false,
        );
    // Thrown only after the transaction commits, so the audited refusal is kept.
    if ('refused' in outcome) throw outcome.refused;
    return outcome.updated;
  }

  private async applyTransition(
    repos: IncidentRepositories,
    incidentId: string,
    input: TransitionInput,
    locked: boolean,
  ): Promise<{ updated: IncidentRow } | { refused: InvalidTransitionError }> {
    const incident = locked ? await repos.incidents.byIdForUpdate(incidentId) : await repos.incidents.byId(incidentId);
    if (!incident) throw new Error(`Unknown incident ${incidentId}`);

    const from = incident.state as IncidentState;
    try {
      assertTransition(from, input.to);
    } catch (err) {
      if (!(err instanceof InvalidTransitionError)) throw err;
      await repos.audit.record({
        organizationId: incident.organizationId,
        incidentId,
        actor: input.actor ?? 'system',
        action: `incident.transition:${from}->${input.to}`,
        allowed: false,
        denialReason: err.message,
        detail: { summary: input.summary },
      });
      return { refused: err };
    }

    const patch: Parameters<IncidentRepository['update']>[1] = { state: input.to };
    // Only VERIFYING_RECOVERY reaches RESOLVED, so this is the one place a
    // resolution timestamp can be set.
    if (input.to === 'RESOLVED') patch.resolvedAt = new Date();

    const updated = await repos.incidents.update(incidentId, patch);

    await repos.timeline.append({
      incidentId,
      kind: 'state_changed',
      summary: input.summary,
      fromState: from,
      toState: input.to,
      agentRunId: input.agentRunId ?? null,
      detail: input.detail ?? null,
    });

    await repos.audit.record({
      organizationId: incident.organizationId,
      incidentId,
      actor: input.actor ?? 'system',
      action: `incident.transition:${from}->${input.to}`,
      allowed: true,
      detail: { summary: input.summary },
    });

    return { updated };
  }

  /** Record something that happened without changing state. */
  async note(
    incidentId: string,
    input: { kind: string; summary: string; agentRunId?: string | null; detail?: Record<string, unknown> },
  ): Promise<void> {
    await this.timeline.append({
      incidentId,
      kind: input.kind,
      summary: input.summary,
      agentRunId: input.agentRunId ?? null,
      detail: input.detail ?? null,
    });
  }

  /**
   * Record a deployment attribution verdict.
   *
   * Separate from `transition` because attribution and state are independent: an
   * incident can be INVESTIGATING with attribution still unknown, and concluding
   * EXTERNAL_INCIDENT is a verdict before it is a state change.
   */
  async recordAttribution(
    incidentId: string,
    verdict: 'DEPLOYMENT_LIKELY_RESPONSIBLE' | 'DEPLOYMENT_NOT_RESPONSIBLE' | 'INSUFFICIENT_EVIDENCE' | 'EXTERNAL_INCIDENT',
    confidence: number,
    rationale: string,
  ): Promise<void> {
    await this.incidents.update(incidentId, {
      deploymentAttribution: verdict,
      attributionConfidence: confidence,
    });
    await this.timeline.append({
      incidentId,
      kind: 'attribution_recorded',
      summary: rationale,
      detail: { verdict, confidence },
    });
  }

  async isTerminal(incidentId: string): Promise<boolean> {
    const incident = await this.incidents.byId(incidentId);
    return incident ? isTerminal(incident.state as IncidentState) : false;
  }
}
