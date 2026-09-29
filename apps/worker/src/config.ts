/**
 * What the worker process needs from its environment: only what the operator owns.
 *
 * Every tenant setting — which service, which repository, which channel, whose
 * Datadog keys — now lives in the database and is set from the console. What is left
 * here is the operator's: the database, the master key, the GitHub App, the Slack
 * app's signing secret, an optional fallback model key, and how hard to work.
 * Validated up front: a worker that starts half-configured fails at the first
 * incident instead of at boot.
 */
import { hostname } from 'node:os';

export interface OperatorConfig {
  databaseUrl: string;
  masterKey: string;
  /** Verifies merge clicks. Without it no merge button is offered. */
  slackSigningSecret: string | null;
  slackBaseUrl: string;
  /** The operator's model key, used by workspaces that have not brought their own. */
  operatorAnthropicKey: string | null;
  model: string;
  sandbox: { runner: 'local' } | { runner: 'docker'; image: string };
  /** Jobs this process runs at once, and jobs all processes together may run. */
  concurrency: number;
  maxRunningJobs: number;
  workerId: string;
  port: number;
  once: boolean;
  /** Development only: lets health URLs and twins on private addresses be reached. */
  allowPrivateHealthUrl: boolean;
  notionBaseUrl: string | undefined;
  resendBaseUrl: string | undefined;
}

export class WorkerConfigError extends Error {
  constructor(problems: string[]) {
    super(`The worker cannot start: ${problems.join('; ')}.`);
    this.name = 'WorkerConfigError';
  }
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number, problems: string[]): number {
  const raw = env[key]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) problems.push(`${key} must be a whole number from ${min} to ${max} (got "${raw}")`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OperatorConfig {
  const problems: string[] = [];
  const databaseUrl = env.DATABASE_URL?.trim() ?? '';
  if (!databaseUrl) problems.push('DATABASE_URL is required');
  const masterKey = env.PAGER_MASTER_KEY?.trim() ?? '';
  if (Buffer.from(masterKey, 'base64').length !== 32) problems.push('PAGER_MASTER_KEY must be 32 bytes, base64');
  const runner = env.PAGER_SANDBOX_RUNNER?.trim();
  if (runner && runner !== 'docker' && runner !== 'local') problems.push(`PAGER_SANDBOX_RUNNER must be docker or local (got "${runner}")`);

  const config: OperatorConfig = {
    databaseUrl,
    masterKey,
    slackSigningSecret: env.SLACK_SIGNING_SECRET?.trim() || null,
    slackBaseUrl: env.PAGER_SLACK_URL?.trim() || 'https://slack.com',
    operatorAnthropicKey: env.ANTHROPIC_API_KEY?.trim() || null,
    model: env.PAGER_MODEL?.trim() || 'claude-opus-5',
    sandbox: runner === 'docker' ? { runner: 'docker', image: env.PAGER_SANDBOX_IMAGE?.trim() || 'node:22-bookworm-slim' } : { runner: 'local' },
    concurrency: int(env, 'PAGER_WORKER_CONCURRENCY', 2, 1, 64, problems),
    maxRunningJobs: int(env, 'PAGER_MAX_RUNNING_JOBS', 4, 1, 1024, problems),
    workerId: env.PAGER_WORKER_ID?.trim() || `${hostname()}:${process.pid}`,
    port: int(env, 'PORT', 10000, 1, 65535, problems),
    once: env.PAGER_WORKER_ONCE === '1',
    allowPrivateHealthUrl: env.PAGER_ALLOW_PRIVATE_HEALTH_URL === '1',
    notionBaseUrl: env.PAGER_NOTION_URL?.trim() || undefined,
    resendBaseUrl: env.PAGER_RESEND_URL?.trim() || undefined,
  };
  if (problems.length > 0) throw new WorkerConfigError(problems);
  return config;
}

/** A description safe to log: names what is configured, never any value. */
export function describeConfig(config: OperatorConfig): string {
  return [
    `database       ${config.databaseUrl.startsWith('pglite://') ? `${config.databaseUrl} (in-process, development)` : 'postgres'}`,
    `worker         ${config.workerId}, ${config.concurrency} at once, ${config.maxRunningJobs} across all workers`,
    `model          ${config.model}${config.operatorAnthropicKey ? ' (operator key as fallback)' : ' (workspaces must bring a key)'}`,
    `merge button   ${config.slackSigningSecret ? 'offered at L4, to linked owners and admins' : 'off — no SLACK_SIGNING_SECRET'}`,
    `health URLs    ${config.allowPrivateHealthUrl ? 'PRIVATE ADDRESSES ALLOWED — local drills only' : 'public https only'}`,
    `sandbox        ${
      config.sandbox.runner === 'docker'
        ? `docker (${config.sandbox.image}) — no network, read-only root, non-root, resource-limited`
        : 'LOCAL PROCESS — DEVELOPMENT ONLY: repository code runs on this host as this user'
    }`,
  ].join('\n  ');
}
