# Pager Developer — Architecture

> Status: living document, describing the code as it is. Last brought into line with
> the code on 2026-09-30. §12 keeps the original plan from 2026-09-13 for the record;
> where the plan and the code disagree, the code wins and this document should be
> corrected.

## 1. What this is

Pager Developer is an AI production engineer. It watches a service in production,
notices when a deployment breaks it, works out why, reproduces the failure, writes and
proves a fix, and gives a person a reviewable pull request with the evidence
attached. A person merges it.

> Production broke. I investigated it. Here is the root cause. Here is the evidence.
> I reproduced it. Here is the tested fix. Approve?

It is a multi-tenant product. A workspace signs up with GitHub, installs the GitHub
App on the repositories it chooses, connects Datadog or Sentry and Slack, and adds a
service to watch.

## 2. Running system

```
 browser ──▶ apps/web  (Next.js console, Auth.js GitHub sign-in)
               │  one-minute HMAC token naming user + workspace
               ▼
             apps/api  (Fastify)  ── Postgres ──  apps/worker
               │  console routes, integrations,        │  polls every enabled service,
               │  GitHub/Slack installs, webhooks      │  runs incidents from a job queue
               ▼                                       ▼
        GitHub App · Slack app · Datadog · Sentry · Notion · Resend · Anthropic
```

- **apps/web** is the console. Sign-in is GitHub OAuth through the operator's GitHub
  App. The console never reads the database. It calls the API from its own server,
  presenting a one-minute token signed with `PAGER_SESSION_SECRET` that names the user
  and the workspace. No token reaches a browser.
- **apps/api** re-reads the membership on every request and takes the workspace only
  from the token. It owns the onboarding flows: the GitHub App install (the setup
  callback is accepted only with a state it signed, and after GitHub confirms, from
  the installer's own OAuth code, that the installer can see the installation), the
  Slack OAuth v2 install, integration credentials and connection tests, services, the
  plan and budget, and the GitHub and Sentry webhooks.
- **apps/worker** holds nothing between jobs. Several workers can share one database.
  - **Queue:** `jobs`, claimed with `FOR UPDATE SKIP LOCKED` under a transaction-scoped
    advisory lock, with a global cap on running jobs.
  - **Leases:** each job has a lease and a heartbeat. A killed worker's lease expires
    and another worker reclaims the job.
  - **Polls:** every enabled service has a `poll` job queued. It probes the service's
    health URL for the deployed revision and asks the alert source whether anything
    novel is failing. Each distinct novel failure becomes a `run_incident` job, one per
    (revision, failure).
  - **Checkpoints:** an incident run records checkpoints in `revision_runs` (incident,
    ticket, Slack thread, branch, pull request), so a restarted worker resumes rather
    than repeats.
  - **Aftermath:** after the pull request, `await_merge` and `verify_recovery` jobs wait
    on the human merge and the deploy.
  - **Merge clicks:** Slack's interactivity requests reach the worker at
    `/slack/interactions`.
- **Postgres** is the only shared state; the API migrates it before each deploy.
  PGlite, which is PostgreSQL compiled to WASM, serves development and tests with the
  same schema and migrations. No component uses Redis. The `redis` service in
  `docker-compose.yml` and `REDIS_URL` are leftovers.

## 3. Tenancy and authentication

| Concern | How |
| --- | --- |
| Sign-in | GitHub OAuth (Auth.js), with the GitHub App's client. The first sign-in creates a workspace with the person as owner. |
| Console → API | One-minute HMAC token (`api-session`) naming user and workspace; the membership is re-read per request. |
| Roles | owner, admin, member. Installing integrations and adding services needs owner or admin; the budget, owner. |
| Isolation | Every tenant table carries `organization_id`; queries are scoped by it; a test suite checks every console route across two workspaces. |
| Tenant secrets | Envelope encryption: AES-256-GCM with a data key per row, wrapped by `PAGER_MASTER_KEY`. The workspace and kind of secret are the AAD. `KeyWrapper` is the seam for a KMS. |
| GitHub | One operator App. Every job mints an installation token narrowed to the one repository it works on. |
| Slack | One operator app; each workspace installs it and its bot token goes straight into the vault. Members are linked by email so a merge click is attributable to a person. |
| Plans | `plans` rows (placeholder limits: services per workspace, incidents per month, included model spend). Stripe is not wired. |

## 4. Package layout

```
packages/
  core/          domain types, zod schemas, incident state machine, policy engine,
                 signed tokens, envelope encryption, redaction, service config rules
  db/            Drizzle schema and migrations, repositories, the job queue, the vault
  providers/     vendor adapters against the real APIs: GitHub (REST + git over HTTPS),
                 Datadog, Sentry, Slack, Jira, Linear, Notion, Resend; the GitHub App
                 client; connection tests; safe fetch; the registry for development
  observability/ the tracer: every agent run and tool call recorded, locally and to Lemma
  agents/        the workflow, production watcher, investigator, patch generators,
                 recovery verifier, usage metering
  sandbox/       a shallow clone of the deployed revision, dependency install, runners
                 (local process, Docker), validation, reproduction, patch policy
  twin-local/    in-process twins of every vendor, the GitHub one serving real git
apps/
  api/           the Fastify API
  web/           the Next.js console and landing page
  worker/        the multi-tenant worker
evals/           the benchmark (evals/src/bench), the end-to-end demos, the agent eval,
                 the opt-in contract tests (evals/contract)
demo/            runnable demo services: checkout-api (Node), orders (express + vitest),
                 billing (Python)
```

## 5. Providers

Business logic never knows which backend it is talking to. Adapters are written
against the vendor's real API and constructed with a resolved base URL and
credentials. Nothing downstream branches on twin versus production. The local twins
implement the vendors' protocols, git's smart HTTP included, so the same adapter code
runs against both.

The interfaces (`packages/providers/src/types.ts`):

- `SourceControlProvider`: commits, diffs, comparisons, files, the default branch,
  branches, pull requests, commits of file changes, merge (pinned to a head sha), and
  a clone URL with a git auth environment that keeps the token out of URLs and disk.
- `ObservabilityProvider`: metric series, logs and monitors, and its `backend`.
- `AlertSource`: where incidents are noticed, meaning what is alerting and the errors
  behind it. Those errors come either as log lines for the watcher to cluster
  (Datadog) or as groups the backend already structured, with typed in-app frames
  (Sentry). It is polled. A push (Sentry's webhook) wakes the service's poll rather
  than bypassing it.
- `MessagingProvider`, `IssueTrackerProvider`, `KnowledgeProvider`, `EmailProvider`.
  Trackers and knowledge are optional and resolve to `null` when unconfigured.

The product builds a tenant's providers per job from that workspace's own
installations and vault entries (`apps/worker/src/tenant.ts`). The registry in
`packages/providers/src/registry.ts` selects `arga | local | real` backends from the
environment for the demos and evaluations. Where its `real` backend takes a static
credential (`GITHUB_TOKEN` and the like), that is development only; the product never
uses one.

## 6. An incident

1. **Watch.** The watcher lists alerts from the service's alert source, reads the
   errors in a window that always ends now (capped, so stale errors fall outside it),
   and groups them into up to three distinct failures, one per root frame. Each is
   checked against the runbooks' known failure modes: same error type and a named
   location or message fragment, never a substring. Each novel failure is its own
   incident.
2. **Identify.** The deployed revision comes from the service itself, via its health
   URL, never from a branch head. Stack paths are mapped onto the repository's own
   files at that revision.
3. **Open, notify, investigate.** Open the incident, the ticket and one Slack thread.
   The investigator works with read-only tools. If it abstains, or reaches no
   diagnosis, the incident is handed over.
4. **Did the deployment cause it?** If the same failure was already happening in the
   hour before the deploy, it is handed over rather than repaired as this deploy's
   regression.
5. **Sandbox.** A shallow, blob-filtered clone of the deployed sha. Dependencies are
   installed frozen from the lockfile with lifecycle scripts off, cached by lockfile
   hash, and the install is the only step with network. The suite then runs twice, and
   the tests that fail in both runs, or in one, are set aside by name.
6. **Reproduce.** A new regression test must fail against the deployed code, twice, for
   the predicted reason, as an assertion and not a load error.
7. **Patch and validate.** The patch may not touch tests, CI, lockfiles or runner
   config. The regression test must then pass twice, and the whole suite must be green
   apart from the set-aside tests, without shrinking. There is one repair attempt.
8. **Pull request**, carrying the evidence, what was set aside and why, and how to
   roll back.
9. **After the human merge**, wait for the deploy, then compare metrics either side.
   The verdict is RECOVERED, NOT_RECOVERED or UNVERIFIABLE, and a recovery that was
   not measured is never claimed. The postmortem goes to Notion and the team is
   emailed.

Languages: TypeScript and JavaScript (node:test, vitest, jest; npm, pnpm, yarn, bun)
and Python (pytest; uv or a fully pinned requirements file).

## 7. Evidence and the data model

`evidence` is the spine. Every row cites the tool call that produced it
(`source_tool_call_id`, `NOT NULL`, foreign-keyed to `tool_calls`), so a fabricated
observation is refused by the database as well as by the code. Observability evidence
is `OBS_METRIC`, `OBS_LOG` or `OBS_ALERT` with a `backend` column; it is never named
for a vendor. Provenance is `OBSERVED` or `DERIVED`, so an inference is never rendered
as a reading.

The incident state machine is an explicit allow-list in `packages/core`, and the
workflow advances only forward along it. The model proposes; the state machine
decides.

## 8. Permissions

Every write is checked against the policy engine at the service's autonomy level
(L0–L5, default L3: may open a pull request, may not execute remediation). Some
capabilities are prohibited at every level: push to the default branch, delete
production data, modify a production database, modify IAM, rotate credentials,
destroy infrastructure, execute arbitrary production commands, deploy arbitrary code,
disable security controls. Merging needs L4 plus a verified Slack click by a linked
owner or admin, pinned to the reviewed commit. See [SECURITY.md](../SECURITY.md).

## 9. Model usage

Model calls go through a meter that prices them from Anthropic's published rates. An
unknown model is priced as unknown, never as free. Usage is recorded per workspace,
and a run stops, and says so, when the workspace's monthly budget is reached. The
stable part of the prompt is cached.

## 10. Evaluation

- `pnpm bench`: 33 generated scenarios across three repositories and two languages.
  24 are bugs of nine kinds; 9 are negative controls where the right action is no pull
  request. Each pull request is judged against a hidden oracle on a fresh clone. The
  runs are repeated, reported with Wilson intervals, and the report says whether a
  model or a script did the authoring. See [benchmark.md](benchmark.md).
- `pnpm demo:e2e`: the three demo services, from alert to pull request, through
  Datadog and through Sentry.
- `pnpm test:contract`: the adapters against the vendors' real APIs, opt-in.
- CI runs `pnpm verify`, the deterministic benchmark subset and the end-to-end demos.

## 11. Deployment

`render.yaml` declares the console, the API, the worker and Postgres. The API migrates
before each deploy. On Render the sandbox is a local process, since Render runs no
Docker daemon. That is not isolation between tenants; untrusted workspaces need a
worker with Docker.

## 12. The original plan (2026-09-13)

Kept for the reasoning. It is superseded where it disagrees with the sections above.

The repository started empty. The choices made then still hold:

- **Fastify instead of NestJS:** the backend is an orchestrator, not a CRUD API.
- **Drizzle instead of Prisma:** the schema is plain TypeScript, so the domain types
  and the tables cannot drift apart.
- **PGlite for development and tests:** real PostgreSQL in process, so the evaluation
  suite cannot be blocked on infrastructure being up.

The plan named a BullMQ/Redis event bus, a git-worktree sandbox, "authentication:
deferred", and twelve Arga scenarios. None was built that way:

- The queue is Postgres.
- The sandbox is a clone into a temporary directory.
- Authentication is §3.
- The evaluation is §10.

Arga's constraints found then still apply to the `arga` backend:

- one twin per run, with a ten-minute TTL
- no credentials in `envVars`, so the GitHub App manifest flow is the way in
- no computed diffs
- git clone over HTTPS is almost certainly not supported (untested), and the sandbox
  now needs it.
