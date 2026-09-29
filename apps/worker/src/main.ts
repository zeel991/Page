/**
 * Pager Developer, running as a service — for every workspace at once.
 *
 * The worker claims jobs from a Postgres queue: poll each enabled service on its
 * interval, run an incident when one is new, wait on the human merge, verify
 * recovery. Everything it knows is in the database, so it can be restarted, or run
 * as several processes, without losing an incident in flight.
 *
 * Two properties matter more than the loop itself:
 *
 *  - It will not act twice on the same deployment. An incident is keyed to the
 *    service and the deployed revision, durably.
 *  - It never merges and never deploys. The only production-affecting act in the
 *    whole system is a person merging the pull request it opened.
 */
import { createServer } from 'node:http';
import { LocalKeyWrapper, redactSecrets, registerSecret } from '@pager/core';
import { CredentialVault, JobQueue, createDatabase, isPgliteUrl, migrate } from '@pager/db';
import { githubAppFromEnv } from '@pager/providers';
import { AnthropicModel, IncidentInvestigator, ModelPatchGenerator } from '@pager/agents';
import { DockerRunner, LocalProcessRunner } from '@pager/sandbox';
import { describeConfig, loadConfig } from './config.ts';
import type { JobContext } from './jobs.ts';
import { handleSlackInteraction } from './merge-endpoint.ts';
import { databaseMergeRouting } from './merge-routing.ts';
import { Worker } from './worker.ts';

const log = (message: string): void => {
  // Everything logged may have come from a vendor error or a command's output.
  console.log(`${new Date().toISOString()}  ${redactSecrets(message)}`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  for (const secret of [config.masterKey, config.slackSigningSecret, config.operatorAnthropicKey]) registerSecret(secret);
  const github = githubAppFromEnv(process.env);
  if (!github) throw new Error('The worker needs the GitHub App (GITHUB_APP_*): every repository is reached through it.');
  registerSecret(github.config.clientSecret);
  registerSecret(github.config.webhookSecret);
  log(`Pager Developer worker starting\n  ${describeConfig(config)}`);

  const handle = await createDatabase(config.databaseUrl);
  // Migrations are a release step against Postgres. An in-process development
  // database has no release step, so it is brought up to date here.
  if (isPgliteUrl(config.databaseUrl)) await migrate(handle);

  const vault = new CredentialVault(handle.db, new LocalKeyWrapper(config.masterKey));
  const queue = new JobQueue(handle.db, { workerId: config.workerId, maxRunning: config.maxRunningJobs });
  const ctx: JobContext = {
    op: {
      db: handle.db,
      vault,
      github,
      slackBaseUrl: config.slackBaseUrl,
      allowPrivateHealthUrl: config.allowPrivateHealthUrl,
      ...(config.notionBaseUrl ? { notionBaseUrl: config.notionBaseUrl } : {}),
      ...(config.resendBaseUrl ? { resendBaseUrl: config.resendBaseUrl } : {}),
    },
    queue,
    sandboxRunner: config.sandbox.runner === 'docker' ? new DockerRunner({ image: config.sandbox.image }) : new LocalProcessRunner(),
    // A workspace's own key when it brought one; otherwise the operator's, if any.
    // With neither, the workflow still detects, files and reports, and stops short of
    // a patch, saying why.
    agentsFor: (tenant) => {
      const apiKey = tenant.anthropicKey ?? config.operatorAnthropicKey;
      if (!apiKey) return {};
      registerSecret(apiKey);
      const model = new AnthropicModel({ apiKey, model: config.model });
      return {
        model: config.model,
        patchGenerator: new ModelPatchGenerator({ model, tracer: tenant.tracer }),
        investigator: new IncidentInvestigator({
          model,
          tracer: tenant.tracer,
          autonomy: tenant.autonomy,
          providers: { observability: tenant.observability, sourceControl: tenant.sourceControl, knowledge: tenant.knowledge },
        }),
      };
    },
    mergeButton: Boolean(config.slackSigningSecret),
    log,
  };
  const worker = new Worker(queue, ctx, { concurrency: config.concurrency, log });

  if (config.once) {
    await queue.reapExpired();
    await worker.schedulePolls();
    await worker.drain();
    await handle.close();
    return;
  }

  // Health, queue depth (no tenant data), and the Slack interaction endpoint.
  const routing = databaseMergeRouting(handle.db, github);
  createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'POST' && path === '/slack/interactions') {
      if (!config.slackSigningSecret) {
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ text: 'This deployment does not offer merging from Slack.' }));
        return;
      }
      void handleSlackInteraction(request, response, { signingSecret: config.slackSigningSecret, routing, log });
      return;
    }
    if (path === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', service: 'pager-developer-worker' }));
      return;
    }
    if (path === '/status') {
      void queue.counts().then(
        (counts) => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ workerId: config.workerId, queue: counts }));
        },
        () => {
          response.writeHead(503, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'database unavailable' }));
        },
      );
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
  }).listen(config.port, '0.0.0.0', () => log(`listening on ${config.port}`));

  const shutdown = async (): Promise<void> => {
    log('stopping: finishing running jobs; unfinished ones resume on the next worker');
    await worker.stop();
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await worker.start();
}

void main().catch((err) => {
  console.error(redactSecrets(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
