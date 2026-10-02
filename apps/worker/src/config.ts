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
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

export interface OperatorConfig {
  databaseUrl: string;
  masterKey: string;
  /** Verifies merge clicks. Without it no merge button is offered. */
  slackSigningSecret: string | null;
  slackBaseUrl: string;
  /** The operator's model key, used by workspaces that have not brought their own. */
  operatorAnthropicKey: string | null;
  model: string;
  sandbox:
    | { runner: 'local'; root: string | undefined }
    | { runner: 'docker'; image: string; runtime: string | undefined; root: string | undefined };
  /** Where installed dependency trees are cached between incidents, by lockfile hash. */
  dependencyCacheDir: string;
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
  const runner = env.PAGER_SANDBOX_RUNNER?.trim() || 'local';
  if (runner !== 'docker' && runner !== 'local') problems.push(`PAGER_SANDBOX_RUNNER must be docker or local (got "${runner}")`);
  // The local runner starts repository code as this process's own user, and a
  // process can read its parent's environment (/proc/<pid>/environ): the master key,
  // the database URL and the GitHub App's key, which together reach every workspace.
  // So against a real database it is refused unless the operator says every
  // workspace is trusted. An in-process development database has no tenants to lose.
  const development = databaseUrl.startsWith('pglite://');
  if (runner === 'local' && databaseUrl && !development && env.PAGER_ALLOW_LOCAL_SANDBOX !== '1') {
    problems.push(
      'PAGER_SANDBOX_RUNNER is local (or unset) against a real database. Repository code would run as this ' +
        "worker's user and could read its credentials. Set PAGER_SANDBOX_RUNNER=docker (see deploy/worker), or " +
        'PAGER_ALLOW_LOCAL_SANDBOX=1 only if every workspace on this deployment is trusted',
    );
  }
  const image = env.PAGER_SANDBOX_IMAGE?.trim() || '';
  if (runner === 'docker' && !image) problems.push('PAGER_SANDBOX_IMAGE is required with the docker sandbox (build docker/sandbox.Dockerfile)');
  const sandboxRoot = env.PAGER_SANDBOX_ROOT?.trim() || undefined;

  const config: OperatorConfig = {
    databaseUrl,
    masterKey,
    slackSigningSecret: env.SLACK_SIGNING_SECRET?.trim() || null,
    slackBaseUrl: env.PAGER_SLACK_URL?.trim() || 'https://slack.com',
    operatorAnthropicKey: env.ANTHROPIC_API_KEY?.trim() || null,
    model: env.PAGER_MODEL?.trim() || 'claude-opus-5',
    sandbox:
      runner === 'docker'
        ? { runner: 'docker', image, runtime: env.PAGER_SANDBOX_DOCKER_RUNTIME?.trim() || undefined, root: sandboxRoot }
        : { runner: 'local', root: sandboxRoot },
    dependencyCacheDir: env.PAGER_DEPENDENCY_CACHE?.trim() || join(tmpdir(), 'pager-dependency-cache'),
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
        ? `docker (${config.sandbox.image}${config.sandbox.runtime ? `, runtime ${config.sandbox.runtime}` : ''}) — no network, read-only root, non-root, resource-limited`
        : 'LOCAL PROCESS — TRUSTED WORKSPACES ONLY: repository code runs on this host as this user'
    }`,
  ].join('\n  ');
}
