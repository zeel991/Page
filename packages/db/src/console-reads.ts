import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import {
  AgentRunRepository,
  AuditRepository,
  EvidenceRepository,
  FixRepository,
  InvestigationRepository,
  TimelineRepository,
} from './repositories.js';
import {
  deploymentCommits,
  deploymentFiles,
  deploymentPullRequests,
  deployments,
  incidents,
  organizations,
  policies,
  services,
  telemetrySnapshots,
} from './schema.js';

/**
 * Everything the console reads, scoped to one workspace.
 *
 * Constructed with an organisation id and unable to read outside it: every query
 * filters on it, and a record belonging to another workspace is simply not found —
 * which the API reports as 404, never 403, so it does not even confirm the id exists.
 *
 * The id comes from the verified session, never from a request.
 */
export class ConsoleReads {
  constructor(
    private readonly db: Database,
    readonly organizationId: string,
  ) {}

  async organization() {
    const [org] = await this.db.select().from(organizations).where(eq(organizations.id, this.organizationId)).limit(1);
    return org ?? null;
  }

  async overview() {
    const org = await this.organization();
    const allIncidents = await this.incidents();
    const recentDeployments = await this.deployments(10);
    const open = allIncidents.filter((i) => i.resolvedAt === null);
    return {
      organization: org ? { id: org.id, name: org.name, autonomyLevel: org.autonomyLevel } : null,
      incidents: allIncidents.slice(0, 20),
      deployments: recentDeployments,
      counts: {
        activeIncidents: open.length,
        investigating: open.filter((i) => i.state === 'INVESTIGATING').length,
        awaitingApproval: open.filter((i) => i.state === 'AWAITING_APPROVAL').length,
        resolved: allIncidents.filter((i) => i.resolvedAt !== null).length,
        deploymentsTracked: recentDeployments.length,
        // An incident with no attribution yet is the honest default, and worth
        // surfacing: it is the queue of things still genuinely unknown.
        unattributed: open.filter((i) => i.deploymentAttribution === null).length,
      },
    };
  }

  async incidents() {
    return this.db
      .select()
      .from(incidents)
      .where(eq(incidents.organizationId, this.organizationId))
      .orderBy(desc(incidents.openedAt));
  }

  /** The incident page: everything known about one incident, or null outside this workspace. */
  async incidentDetail(id: string) {
    const [incident] = await this.db
      .select()
      .from(incidents)
      .where(and(eq(incidents.id, id), eq(incidents.organizationId, this.organizationId)))
      .limit(1);
    if (!incident) return null;

    const [service] = await this.db
      .select()
      .from(services)
      .where(and(eq(services.id, incident.serviceId), eq(services.organizationId, this.organizationId)))
      .limit(1);
    const deployment = incident.suspectedDeploymentId ? await this.deployment(incident.suspectedDeploymentId) : null;

    const agentRuns = new AgentRunRepository(this.db);
    const runs = await agentRuns.forIncident(incident.id);
    const investigations = new InvestigationRepository(this.db);

    return {
      incident,
      service: service ?? null,
      deployment: deployment ? { ...deployment.deployment, files: deployment.files, commits: deployment.commits, pullRequests: deployment.pullRequests } : null,
      timeline: await new TimelineRepository(this.db).forIncident(incident.id),
      evidence: await new EvidenceRepository(this.db).forIncident(incident.id),
      agentRuns: await Promise.all(runs.map(async (run) => ({ ...run, toolCalls: await agentRuns.toolCallsForRun(run.id) }))),
      auditLog: await new AuditRepository(this.db).forIncident(incident.id),
      // Joined on the service, not the deployment: an alert-driven incident has
      // telemetry but may have no deployment associated with it at all.
      telemetry: await this.db
        .select()
        .from(telemetrySnapshots)
        .where(and(eq(telemetrySnapshots.serviceId, incident.serviceId), eq(telemetrySnapshots.organizationId, this.organizationId)))
        .orderBy(asc(telemetrySnapshots.metric)),
      // What was inferred, kept separate from what was observed.
      investigations: await investigations.forIncident(incident.id),
      hypotheses: await investigations.hypothesesForIncident(incident.id),
      // The proposed fix, with the exit codes of every check that really ran.
      fixes: await new FixRepository(this.db).forIncident(incident.id),
    };
  }

  async deployments(limit = 50) {
    return this.db
      .select()
      .from(deployments)
      .where(eq(deployments.organizationId, this.organizationId))
      .orderBy(desc(deployments.startedAt))
      .limit(limit);
  }

  async deployment(id: string) {
    const [deployment] = await this.db
      .select()
      .from(deployments)
      .where(and(eq(deployments.id, id), eq(deployments.organizationId, this.organizationId)))
      .limit(1);
    if (!deployment) return null;
    const [files, commits, pullRequests] = await Promise.all([
      this.db.select().from(deploymentFiles).where(eq(deploymentFiles.deploymentId, deployment.id)),
      this.db.select().from(deploymentCommits).where(eq(deploymentCommits.deploymentId, deployment.id)),
      this.db.select().from(deploymentPullRequests).where(eq(deploymentPullRequests.deploymentId, deployment.id)),
    ]);
    return { deployment, files, commits, pullRequests };
  }

  async services() {
    return this.db.select().from(services).where(eq(services.organizationId, this.organizationId));
  }

  async policies() {
    return this.db.select().from(policies).where(eq(policies.organizationId, this.organizationId)).orderBy(asc(policies.name));
  }

  /** Agent observability: every run in this workspace, and how its tool calls went. */
  async agentRunStats() {
    const agents = await this.db.execute(
      sql`select agent_name, status, count(*)::int as runs,
                 avg(extract(epoch from (ended_at - started_at)) * 1000)::int as avg_ms
          from agent_runs where organization_id = ${this.organizationId}
          group by agent_name, status order by agent_name`,
    );
    const tools = await this.db.execute(
      sql`select tool_name, status, count(*)::int as calls, avg(duration_ms)::int as avg_ms
          from tool_calls where organization_id = ${this.organizationId}
          group by tool_name, status order by calls desc`,
    );
    return { agents: rowsOf(agents), tools: rowsOf(tools) };
  }
}

function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  return (result as { rows?: unknown[] }).rows ?? [];
}
