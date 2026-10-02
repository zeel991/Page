import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isDatadogApiUrl, isSentryApiUrl, serviceConfigProblems, type ServiceConfig } from '@pager/core';
import {
  InstallationRepository,
  IntegrationRepository,
  ServiceConfigRepository,
  JobQueue,
  PlanRepository,
  SlackRepository,
  UsageRepository,
  jobs,
  and,
  eq,
  desc,
  type CredentialVault,
  type Database,
  type IntegrationProvider,
} from '@pager/db';
import {
  probeDeployedRevision,
  testAnthropic,
  testDatadog,
  testNotion,
  testResend,
  testSentry,
  type ConnectionResult,
  type GitHubAppClient,
  type SlackAppClient,
} from '@pager/providers';
import { auth, requireRole } from './auth.ts';

/**
 * Integrations and watched services, configured from the console.
 *
 * Everything the single-tenant worker read from its environment is set here, and
 * validated here with the rules `loadConfig` used to apply at boot. A service is
 * refused at the form when it could not be watched: an unknown repository, a
 * channel the bot cannot see, a missing Datadog connection.
 */

export interface ConfigPolicy {
  /** Which Datadog base URLs a workspace may configure. Default: Datadog's own API hosts only. */
  allowDatadogUrl?: (url: string) => boolean;
  /** Which Sentry base URLs a workspace may configure. Default: sentry.io and its regional hosts. */
  allowSentryUrl?: (url: string) => boolean;
  /** Health URLs are tenant input; private addresses are refused unless this is set, for tests. */
  allowPrivateHealthUrl?: boolean;
  /** Base URLs for Notion and Resend, for tests against the twin. */
  notionBaseUrl?: string;
  resendBaseUrl?: string;
  anthropicBaseUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
}

export interface ConfigRouteDeps {
  db: Database;
  vault: CredentialVault;
  github: GitHubAppClient | null;
  slack: SlackAppClient | null;
  policy?: ConfigPolicy;
  /** The clock month-to-date spend is counted by; the wall clock unless a test sets one. */
  now?: () => Date;
}

const Datadog = z.object({
  site: z.string().url(),
  apiKey: z.string().min(16).optional(),
  appKey: z.string().min(16).optional(),
});
const Sentry = z.object({
  baseUrl: z.string().url().default('https://sentry.io'),
  organization: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'an organization slug'),
  token: z.string().min(16).optional(),
  /** The integration's client secret, which signs Sentry's webhooks. */
  webhookSecret: z.string().min(16).optional(),
});
const Notion = z.object({ token: z.string().min(8) });
const Resend = z.object({ apiKey: z.string().min(8), from: z.string().email().or(z.string().regex(/^.+<[^@\s]+@[^@\s]+>$/)) });
const Anthropic = z.object({ apiKey: z.string().min(16) });

export async function registerConfigRoutes(app: FastifyInstance, deps: ConfigRouteDeps): Promise<void> {
  const integrations = new IntegrationRepository(deps.db);
  const services = new ServiceConfigRepository(deps.db);
  const installations = new InstallationRepository(deps.db);
  const slack = new SlackRepository(deps.db);
  const policy = deps.policy ?? {};
  const allowDatadog = policy.allowDatadogUrl ?? isDatadogApiUrl;
  const allowSentry = policy.allowSentryUrl ?? isSentryApiUrl;
  const org = (request: FastifyRequest) => auth(request).organizationId;

  // ── Integrations ─────────────────────────────────────────────────────────────
  app.get('/api/integrations', async (request) => {
    const o = org(request);
    const rows = await integrations.list(o);
    const secrets = await deps.vault.describe(o);
    const find = (p: string) => rows.find((r) => r.provider === p) ?? null;
    const keys = (prefix: string) => secrets.filter((s) => s.kind.startsWith(prefix)).map((s) => ({ kind: s.kind, last4: s.last4 }));
    const status = (p: IntegrationProvider) => {
      const row = find(p);
      return row
        ? { configured: true, baseUrl: row.baseUrl, config: row.config, verifiedAt: row.verifiedAt, lastError: row.lastError, keys: keys(`${p}.`) }
        : { configured: false, keys: keys(`${p}.`) };
    };
    const slackRow = await slack.forOrganization(o);
    return {
      github: { installations: (await installations.active(o)).map((i) => ({ id: i.id, accountLogin: i.accountLogin })) },
      slack: slackRow ? { teamId: slackRow.teamId, teamName: slackRow.teamName } : null,
      datadog: status('datadog'),
      sentry: status('sentry'),
      notion: status('notion'),
      resend: status('resend'),
      anthropic: status('anthropic'),
    };
  });

  app.put('/api/integrations/datadog', async (request, reply) => {
    if (!requireRole(request, reply, ['owner', 'admin'])) return reply;
    const parsed = Datadog.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'site must be a URL; keys at least 16 characters' });
    const site = parsed.data.site.replace(/\/+$/, '');
    // Keys are sent to this URL, so it must be Datadog's own API host.
    if (!allowDatadog(site)) return reply.code(422).send({ problems: { site: 'must be a Datadog API site, such as https://api.datadoghq.eu' } });
    const o = org(request);
    if (parsed.data.apiKey) await deps.vault.put(o, 'datadog.api_key', parsed.data.apiKey);
    if (parsed.data.appKey) await deps.vault.put(o, 'datadog.app_key', parsed.data.appKey);
    const row = await integrations.upsert(o, 'datadog', { baseUrl: site });
    return { integration: { provider: row.provider, baseUrl: row.baseUrl } };
  });

  app.put('/api/integrations/sentry', async (request, reply) => {
    if (!requireRole(request, reply, ['owner', 'admin'])) return reply;
    const parsed = Sentry.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'organization must be a Sentry organization slug; token at least 16 characters' });
    const baseUrl = parsed.data.baseUrl.replace(/\/+$/, '');
    // The token is sent to this URL, so it must be Sentry's own API.
    if (!allowSentry(baseUrl)) return reply.code(422).send({ problems: { baseUrl: 'must be https://sentry.io or a regional Sentry host' } });
    const o = org(request);
    if (parsed.data.token) await deps.vault.put(o, 'sentry.auth_token', parsed.data.token);
    if (parsed.data.webhookSecret) await deps.vault.put(o, 'sentry.webhook_secret', parsed.data.webhookSecret);
    const row = await integrations.upsert(o, 'sentry', { baseUrl, config: { organization: parsed.data.organization } });
    return { integration: { provider: row.provider, baseUrl: row.baseUrl, organization: parsed.data.organization } };
  });

  app.put('/api/integrations/notion', async (request, reply) => {
    if (!requireRole(request, reply, ['owner', 'admin'])) return reply;
    const parsed = Notion.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'token is required' });
    await deps.vault.put(org(request), 'notion.token', parsed.data.token);
    await integrations.upsert(org(request), 'notion', {});
    return { integration: { provider: 'notion' } };
  });

  app.put('/api/integrations/resend', async (request, reply) => {
    if (!requireRole(request, reply, ['owner', 'admin'])) return reply;
    const parsed = Resend.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'apiKey and a from address are required' });
    await deps.vault.put(org(request), 'resend.api_key', parsed.data.apiKey);
    await integrations.upsert(org(request), 'resend', { config: { from: parsed.data.from } });
    return { integration: { provider: 'resend', from: parsed.data.from } };
  });

  /** Bring your own model key. Stored encrypted; runs in this workspace use it. */
  app.put('/api/integrations/anthropic', async (request, reply) => {
    if (!requireRole(request, reply, ['owner', 'admin'])) return reply;
    const parsed = Anthropic.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'apiKey is required' });
    await deps.vault.put(org(request), 'anthropic.api_key', parsed.data.apiKey);
    await integrations.upsert(org(request), 'anthropic', {});
    return { integration: { provider: 'anthropic' } };
  });

  app.post<{ Params: { provider: string } }>('/api/integrations/:provider/test', async (request, reply) => {
    const o = org(request);
    const provider = request.params.provider;
    let result: ConnectionResult;
    switch (provider) {
      case 'datadog': {
        const row = await integrations.get(o, 'datadog');
        const [apiKey, appKey] = await Promise.all([deps.vault.reveal(o, 'datadog.api_key'), deps.vault.reveal(o, 'datadog.app_key')]);
        result = !row?.baseUrl || !apiKey || !appKey
          ? { ok: false, error: 'Datadog needs a site, an API key and an application key' }
          : await testDatadog({ site: row.baseUrl, apiKey, appKey }, policy.fetchImpl);
        break;
      }
      case 'sentry': {
        const row = await integrations.get(o, 'sentry');
        const token = await deps.vault.reveal(o, 'sentry.auth_token');
        const organization = typeof row?.config.organization === 'string' ? row.config.organization : null;
        result = !row?.baseUrl || !token || !organization
          ? { ok: false, error: 'Sentry needs a base URL, an organization and an auth token' }
          : await testSentry({ baseUrl: row.baseUrl, token, organization }, policy.fetchImpl);
        break;
      }
      case 'notion': {
        const token = await deps.vault.reveal(o, 'notion.token');
        result = token ? await testNotion({ token, ...(policy.notionBaseUrl ? { baseUrl: policy.notionBaseUrl } : {}) }, policy.fetchImpl) : { ok: false, error: 'no Notion token' };
        break;
      }
      case 'resend': {
        const apiKey = await deps.vault.reveal(o, 'resend.api_key');
        result = apiKey ? await testResend({ apiKey, ...(policy.resendBaseUrl ? { baseUrl: policy.resendBaseUrl } : {}) }, policy.fetchImpl) : { ok: false, error: 'no Resend key' };
        break;
      }
      case 'anthropic': {
        const apiKey = await deps.vault.reveal(o, 'anthropic.api_key');
        result = apiKey ? await testAnthropic({ apiKey, ...(policy.anthropicBaseUrl ? { baseUrl: policy.anthropicBaseUrl } : {}) }, policy.fetchImpl) : { ok: false, error: 'no Anthropic key' };
        break;
      }
      case 'slack': {
        const token = await deps.vault.reveal(o, 'slack.bot_token');
        if (!deps.slack || !token) {
          result = { ok: false, error: 'Slack is not connected' };
        } else {
          const t = await deps.slack.authTest(token);
          const expected = (await slack.forOrganization(o))?.teamId;
          result = t.ok && t.teamId === expected ? { ok: true, detail: `bot token valid for ${t.teamId}` } : { ok: false, error: t.ok ? 'token belongs to another team' : t.error };
        }
        return { provider, result };
      }
      case 'github': {
        const active = await installations.active(o);
        if (!deps.github || active.length === 0) {
          result = { ok: false, error: 'the GitHub App is not installed' };
        } else {
          try {
            let count = 0;
            for (const i of active) count += (await deps.github.installationRepositories(i.installationId)).length;
            result = { ok: true, detail: `${active.length} installation(s), ${count} repositories reachable` };
          } catch (err) {
            result = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        return { provider, result };
      }
      default:
        return reply.code(404).send({ error: `unknown integration ${provider}` });
    }
    await integrations.recordTest(o, provider as IntegrationProvider, result.ok ? { ok: true } : { ok: false, error: result.error });
    return { provider, result };
  });

  // ── Model usage and the monthly budget ──────────────────────────────────────
  const usage = new UsageRepository(deps.db);
  app.get('/api/usage', async (request) => {
    const o = org(request);
    const at = deps.now?.() ?? new Date();
    const [monthToDate, byKind, budget] = await Promise.all([usage.monthToDate(o, at), usage.byKind(o, at), usage.budget(o)]);
    return { monthToDate, byKind, monthlyBudgetUsd: budget };
  });

  app.put('/api/budget', async (request, reply) => {
    if (!requireRole(request, reply, ['owner'])) return reply;
    const value = (request.body as { monthlyBudgetUsd?: unknown })?.monthlyBudgetUsd;
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000)) {
      return reply.code(400).send({ error: 'monthlyBudgetUsd must be a non-negative number of dollars, or null' });
    }
    await usage.setBudget(org(request), value as number | null);
    return { monthlyBudgetUsd: value };
  });

  // ── Services ─────────────────────────────────────────────────────────────────
  /** Rules that span entities: what the service names must exist in this workspace. */
  async function crossCheck(o: string, config: ServiceConfig): Promise<Record<string, string>> {
    const problems: Record<string, string> = {};
    const repo = (await installations.repositories(o)).find((r) => r.id === config.repositoryId && !r.detachedAt);
    if (!repo) problems.repositoryId = 'not a repository picked in this workspace';
    if (!(await integrations.get(o, config.alertSource))) problems.alertSource = `connect ${config.alertSource === 'sentry' ? 'Sentry' : 'Datadog'} first`;
    const token = await deps.vault.reveal(o, 'slack.bot_token');
    if (!token || !deps.slack) {
      problems.slackChannelId = 'connect Slack first';
    } else if (!(await deps.slack.channels(token)).some((c) => c.id === config.slackChannelId)) {
      problems.slackChannelId = 'the Slack bot cannot see this channel';
    }
    if (config.emailRecipients.length > 0 && !(await integrations.get(o, 'resend'))) problems.emailRecipients = 'connect Resend to mail the team';
    if (config.notionParentPageId && !(await integrations.get(o, 'notion'))) problems.notionParentPageId = 'connect Notion to file write-ups';
    return problems;
  }

  const plans = new PlanRepository(deps.db);
  const queue = new JobQueue(deps.db, { workerId: 'api' });

  app.post('/api/services', async (request, reply) => {
    if (!requireRole(request, reply, ['owner', 'admin'])) return reply;
    {
      const o = org(request);
      const plan = await plans.forOrganization(o);
      if ((await plans.servicesUsed(o)) >= plan.maxServices) {
        return reply.code(402).send({ error: 'plan_limit', reason: `The ${plan.name} plan watches ${plan.maxServices} service(s).` });
      }
    }
    const { config, problems } = serviceConfigProblems(request.body, { allowInsecureHealthUrl: policy.allowPrivateHealthUrl ?? false });
    if (!config) return reply.code(422).send({ problems });
    const o = org(request);
    const more = await crossCheck(o, config);
    if (Object.keys(more).length > 0) return reply.code(422).send({ problems: more });
    if ((await services.list(o)).some((svc) => svc.name === config.name)) {
      return reply.code(422).send({ problems: { name: 'this workspace already has a service with this name' } });
    }
    return { service: await services.create(o, config) };
  });

  app.patch<{ Params: { id: string } }>('/api/services/:id', async (request, reply) => {
    if (!requireRole(request, reply, ['owner', 'admin'])) return reply;
    const o = org(request);
    const existing = await services.get(o, request.params.id);
    if (!existing) return reply.code(404).send({ error: 'Service not found' });
    const merged = { ...fromRow(existing), ...(request.body as Record<string, unknown>) };
    const { config, problems } = serviceConfigProblems(merged, { allowInsecureHealthUrl: policy.allowPrivateHealthUrl ?? false });
    if (!config) return reply.code(422).send({ problems });
    const more = await crossCheck(o, config);
    if (Object.keys(more).length > 0) return reply.code(422).send({ problems: more });
    return { service: await services.update(o, request.params.id, config) };
  });

  app.post<{ Params: { id: string } }>('/api/services/:id/enabled', async (request, reply) => {
    if (!requireRole(request, reply, ['owner', 'admin'])) return reply;
    const enabled = (request.body as { enabled?: unknown })?.enabled === true;
    const ok = await services.setEnabled(org(request), request.params.id, enabled);
    return ok ? { enabled } : reply.code(404).send({ error: 'Service not found' });
  });

  /** Ask the service what revision it runs, exactly as the worker will. */
  app.post<{ Params: { id: string } }>('/api/services/:id/test-health', async (request, reply) => {
    const o = org(request);
    const svc = await services.get(o, request.params.id);
    if (!svc?.healthUrl) return reply.code(404).send({ error: 'Service not found' });
    const probe = await probeDeployedRevision(svc.healthUrl, { allowPrivate: policy.allowPrivateHealthUrl ?? false, attempts: 1 });
    const result: ConnectionResult = probe.sha ? { ok: true, detail: `reports revision ${probe.sha.slice(0, 12)}` } : { ok: false, error: probe.problem ?? 'no revision' };
    await services.recordHealthTest(o, svc.id, result.ok ? { ok: true } : { ok: false, error: result.error });
    return { result };
  });

  // ── Onboarding: each step's real state, read from what exists ───────────────
  app.get('/api/onboarding', async (request) => {
    const o = org(request);
    const [installs, repos, ddRow, sentryRow, slackRow, svcs, usageNow, sampleJob] = await Promise.all([
      installations.active(o),
      installations.repositories(o),
      integrations.get(o, 'datadog'),
      integrations.get(o, 'sentry'),
      slack.forOrganization(o),
      services.list(o),
      plans.usage(o),
      deps.db.select().from(jobs).where(and(eq(jobs.organizationId, o), eq(jobs.kind, 'test_incident'))).orderBy(desc(jobs.createdAt)).limit(1),
    ]);
    const watched = svcs.filter((s) => s.alertSource !== 'sample');
    const service = watched[0] ?? null;
    // The alert source the service uses, or whichever one is connected before there is a service.
    const dd = service?.alertSource === 'sentry' ? sentryRow : service ? ddRow : (ddRow?.verifiedAt ? ddRow : sentryRow?.verifiedAt ? sentryRow : ddRow ?? sentryRow);
    const polledRecently =
      service?.lastPolledAt && Date.now() - service.lastPolledAt.getTime() < 3 * service.intervalSeconds * 1000;
    const step = (id: string, label: string, status: 'done' | 'todo' | 'attention', detail: string | null = null) => ({ id, label, status, detail });
    return {
      steps: [
        step('signed_in', 'Signed in with GitHub', 'done'),
        step('github', 'Install the GitHub App', installs.length ? 'done' : 'todo', installs.map((i) => i.accountLogin).join(', ') || null),
        step('repository', 'Pick a repository', repos.some((r) => !r.detachedAt) ? 'done' : 'todo', repos.filter((r) => !r.detachedAt).map((r) => r.fullName).join(', ') || null),
        step(
          'datadog',
          'Connect Datadog or Sentry',
          !dd ? 'todo' : dd.verifiedAt ? 'done' : 'attention',
          !dd ? null : dd.verifiedAt ? `verified ${dd.verifiedAt.toISOString()}` : dd.lastError ?? 'connected, not yet tested',
        ),
        step('slack', 'Connect Slack', slackRow ? 'done' : 'todo', slackRow?.teamName ?? null),
        step('service', 'Add a service', service ? 'done' : 'todo', service ? `${service.name} → ${service.slackChannelName ?? service.slackChannelId}` : null),
        step(
          'health',
          'Check the health URL reports a revision',
          !service ? 'todo' : service.healthVerifiedAt ? 'done' : 'attention',
          service?.healthLastError ?? (service?.healthVerifiedAt ? 'reports a revision' : null),
        ),
        step(
          'watching',
          'Being watched',
          !service ? 'todo' : polledRecently ? 'done' : 'attention',
          service?.lastPollOutcome ?? (service ? 'waiting for the first poll' : null),
        ),
      ],
      plan: usageNow,
      testIncident: sampleJob[0]
        ? { status: sampleJob[0].status, result: sampleJob[0].result, error: sampleJob[0].lastError, at: sampleJob[0].createdAt }
        : null,
    };
  });

  /** Run the sample incident for this workspace. One at a time. */
  app.post('/api/test-incident', async (request, reply) => {
    if (!requireRole(request, reply, ['owner', 'admin'])) return reply;
    const o = org(request);
    const job = await queue.enqueue({ organizationId: o, kind: 'test_incident', dedupeKey: `test_incident:${o}`, maxAttempts: 1 });
    return job ? { queued: job.id } : reply.code(409).send({ error: 'already_running', reason: 'A test incident is already queued or running.' });
  });
}

function fromRow(row: Awaited<ReturnType<ServiceConfigRepository['get']>> & object) {
  return {
    name: row.name,
    repositoryId: row.repositoryId,
    healthUrl: row.healthUrl,
    alertSource: row.alertSource,
    slackChannelId: row.slackChannelId,
    slackChannelName: row.slackChannelName,
    baseBranch: row.baseBranch,
    autonomyLevel: row.autonomyLevel,
    readOnly: row.readOnly,
    intervalSeconds: row.intervalSeconds,
    notionParentPageId: row.notionParentPageId,
    emailRecipients: row.emailRecipients,
  };
}
