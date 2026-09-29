import {
  CredentialVault,
  DrizzleTelemetrySink,
  AgentRunRepository,
  AuditRepository,
  EvidenceRepository,
  FixRepository,
  IncidentRepository,
  InstallationRepository,
  IntegrationRepository,
  InvestigationRepository,
  ServiceConfigRepository,
  TelemetryRepository,
  TimelineRepository,
  incidentUnitOfWork,
  type Database,
  type GitHubInstallationRow,
  type RepositoryRow,
  type ServiceRow,
} from '@pager/db';
import {
  DatadogProvider,
  GitHubProvider,
  NotionProvider,
  ResendProvider,
  SlackProvider,
  type EmailProvider,
  type GitHubAppClient,
  type KnowledgeProvider,
  type MessagingProvider,
  type ObservabilityProvider,
  type SourceControlProvider,
} from '@pager/providers';
import { AgentTracer, lemmaFromEnv } from '@pager/observability';
import { IncidentEngine, type WorkflowPersistence } from '@pager/agents';
import type { AutonomyLevel } from '@pager/core';

/**
 * One service's world: its providers, built from its own workspace's credentials.
 *
 * Nothing here comes from the worker's environment except what the operator owns —
 * the GitHub App, the Slack app's base URL, the master key. Every tenant credential is
 * read from the vault at the moment a job needs it, and the GitHub token is narrowed
 * to this service's one repository.
 */

export interface OperatorServices {
  db: Database;
  vault: CredentialVault;
  github: GitHubAppClient;
  slackBaseUrl: string;
  /** Overrides for local twins. Production leaves them to the vendors' own hosts. */
  notionBaseUrl?: string;
  resendBaseUrl?: string;
  /** Tenant health URLs are public https; private addresses only for local drills. */
  allowPrivateHealthUrl: boolean;
  now?: () => Date;
}

export interface Tenant {
  service: ServiceRow;
  repository: RepositoryRow;
  installation: GitHubInstallationRow;
  observability: ObservabilityProvider;
  sourceControl: SourceControlProvider;
  messaging: MessagingProvider;
  knowledge: KnowledgeProvider | null;
  email: EmailProvider | null;
  emailRecipients: string[];
  autonomy: AutonomyLevel;
  /** The workspace's own model key, when it brought one. */
  anthropicKey: string | null;
  tracer: AgentTracer;
  persistence: WorkflowPersistence;
}

/** Why a service cannot be worked on right now, in words the console shows. */
export class TenantUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantUnavailable';
  }
}

export async function tenantFor(op: OperatorServices, serviceId: string): Promise<Tenant> {
  const services = new ServiceConfigRepository(op.db);
  const found = (await services.enabledWithRepository()).find((r) => r.service.id === serviceId);
  if (!found) throw new TenantUnavailable('the service is disabled, or its repository was detached');
  const { service, repository } = found;
  const org = service.organizationId;

  const installations = new InstallationRepository(op.db);
  const installation = (await installations.active(org)).find((i) => i.id === repository.githubInstallationId);
  if (!installation) throw new TenantUnavailable('the GitHub App installation for this repository is gone or suspended');

  const integrations = new IntegrationRepository(op.db);
  const datadog = await integrations.get(org, 'datadog');
  const [ddApi, ddApp, slackToken, notionToken, resendKey, anthropicKey] = await Promise.all([
    op.vault.reveal(org, 'datadog.api_key'),
    op.vault.reveal(org, 'datadog.app_key'),
    op.vault.reveal(org, 'slack.bot_token'),
    op.vault.reveal(org, 'notion.token'),
    op.vault.reveal(org, 'resend.api_key'),
    op.vault.reveal(org, 'anthropic.api_key'),
  ]);
  if (!datadog?.baseUrl || !ddApi || !ddApp) throw new TenantUnavailable('Datadog is not connected');
  if (!slackToken) throw new TenantUnavailable('Slack is not connected');
  if (!service.slackChannelId) throw new TenantUnavailable('the service has no Slack channel');

  const tokens = op.github.tokenSource(installation.installationId, repository.fullName);
  const sourceControl = new GitHubProvider({ baseUrl: op.github.config.apiBaseUrl, tokenProvider: () => tokens.token() });

  const resend = await integrations.get(org, 'resend');
  const from = typeof resend?.config.from === 'string' ? resend.config.from : null;
  const email = resendKey && from && service.emailRecipients.length > 0
    ? new ResendProvider({ baseUrl: op.resendBaseUrl ?? 'https://api.resend.com', apiKey: resendKey, from })
    : null;
  const knowledge = notionToken && service.notionParentPageId
    ? new NotionProvider({ baseUrl: op.notionBaseUrl ?? 'https://api.notion.com', token: notionToken, parentPageId: service.notionParentPageId })
    : null;

  const tracer = new AgentTracer({ sink: new DrizzleTelemetrySink(op.db, { organizationId: org }), lemma: lemmaFromEnv() });
  const incidents = new IncidentRepository(op.db);
  const persistence: WorkflowPersistence = {
    engine: new IncidentEngine(incidents, new TimelineRepository(op.db), new AuditRepository(op.db), incidentUnitOfWork(op.db)),
    evidence: new EvidenceRepository(op.db),
    agentRuns: new AgentRunRepository(op.db),
    telemetry: new TelemetryRepository(op.db),
    investigations: new InvestigationRepository(op.db),
    fixes: new FixRepository(op.db),
    organizationId: org,
    serviceId: service.id,
    repositoryId: repository.id,
  };

  return {
    service,
    repository,
    installation,
    observability: new DatadogProvider({ baseUrl: datadog.baseUrl, apiKey: ddApi, appKey: ddApp }),
    sourceControl,
    messaging: new SlackProvider({ baseUrl: op.slackBaseUrl, token: slackToken }),
    knowledge,
    email,
    emailRecipients: service.emailRecipients,
    autonomy: (service.readOnly ? 'L2' : service.autonomyLevel) as AutonomyLevel,
    anthropicKey,
    tracer,
    persistence,
  };
}
