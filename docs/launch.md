# Launch runbook

Everything needed to take Pager Developer from this repository to open sign-up, as a
**free beta that costs nothing to host**. Paid plans come later ("Taking payments").
Each step that needs an account or a secret is yours to do; nothing here asks you to
paste a secret anywhere but the service that holds it.

At the end, `pnpm launch:check` asks the running services whether they are ready.

## Topology

| Piece | Where | Cost | Limits |
| --- | --- | --- | --- |
| Console (Next.js) | Vercel Hobby | $0 | Non-commercial use only, which is why paid plans wait |
| API | Render, free web service (`render.yaml`) | $0 | Spins down after 15 idle minutes; an uptime monitor on `/health` every 5 minutes keeps it up. That uses ~744 of the 750 free instance hours a month, so it must be the only free Render service |
| Database | Neon, free plan | $0 | Render's free Postgres is deleted 30 days after creation, so not there |
| Worker | Your Mac, with Docker Desktop (`deploy/worker/run-here.sh`) | $0 | Runs while the Mac is awake. Open sign-up runs strangers' test suites, so they run in containers |
| Model | Each workspace's own Anthropic key | $0 to you | Free workspaces include no model spend (migration 0012) |

Hostnames used below: `CONSOLE` (`https://page-iota-six.vercel.app`) and `API`
(`https://pager-api.onrender.com`, or whatever name Render gives it).

## 1. The GitHub App

GitHub → Settings → Developer settings → **GitHub Apps → New GitHub App**:

| Field | Value |
| --- | --- |
| Homepage URL | `CONSOLE` |
| Callback URLs, **in this order** | 1. `CONSOLE/onboarding/github/setup` 2. `CONSOLE/api/auth/callback/github` |
| Request user authorization (OAuth) during installation | **on** (the install is proven with it) |
| Setup URL | unavailable once the option above is on: GitHub sends an installer to the **first** callback URL instead, which is why the setup route comes first. Sign-in names its own callback, so it is unaffected. |
| Webhook URL | `API/webhooks/github`, with a generated secret |
| Repository permissions | Contents, Pull requests, Checks, Issues, Commit statuses: read & write. Metadata: read |
| Account permissions | Email addresses: read |
| Events | Push, Pull request (they appear once the permissions above are set) |
| Where can it be installed | Any account |

Then generate a client secret and a private key. Keep the six values for steps 3 and
6: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (the whole PEM), `GITHUB_APP_SLUG` (the
end of `github.com/apps/<slug>`), `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`,
`GITHUB_APP_WEBHOOK_SECRET`.

## 2. The database on Neon

neon.tech → sign up (the free plan) → create a project (Postgres 17, the region
nearest Render's, e.g. US East / Oregon). Copy its **connection string**: it starts
`postgresql://` and ends `?sslmode=require`. That is `DATABASE_URL` for steps 3 and 6.

## 3. The API on Render

Render → **New → Blueprint** → this repository. It creates `pager-api` on the free
instance type and the `pager-secrets` group. It should not ask for a card; if it
does, something in the blueprint is not on the free type, so stop and say. When asked:

- `DATABASE_URL`: Neon's connection string.
- `PAGER_WEB_ORIGIN`: `CONSOLE`.
- The six `GITHUB_APP_*` values.
- `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`: empty for now (step 5).

The API migrates the database as it starts. When it is live, `curl API/health`
answers `{"status":"ok"}`. From **Environment Groups → pager-secrets**, copy
`PAGER_SESSION_SECRET` (step 4) and `PAGER_MASTER_KEY` (step 6).

Then point an uptime monitor (UptimeRobot's free plan: HTTP, every 5 minutes) at
`API/health`, so the API is awake when GitHub and Slack call it.

## 4. The console on Vercel

Project → Settings → Environment Variables (Production):

| Name | Value |
| --- | --- |
| `AUTH_SECRET` | a new random value: `openssl rand -base64 32` |
| `AUTH_URL` | `CONSOLE` |
| `AUTH_TRUST_HOST` | `true` |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | the GitHub App's client id and secret |
| `PAGER_API_URL` | `API` |
| `PAGER_SESSION_SECRET` | the value from `pager-secrets` |
| `PAGER_LEGAL_NAME` | the legal name of whoever operates the service |
| `PAGER_SUPPORT_EMAIL` | a monitored support address |
| `PAGER_LEGAL_EFFECTIVE_DATE` | optional, shown on the policies |

Redeploy. This fixes the live console's sign-in, which answers `/api/auth/providers`
with a 500 "server configuration" error until `AUTH_SECRET` and the GitHub client are
set.

## 5. The Slack app

api.slack.com → **Create New App** → From scratch:

- **OAuth & Permissions**: redirect URL `CONSOLE/onboarding/slack/callback`; bot
  scopes `chat:write`, `channels:read`, `groups:read`, `users:read`,
  `users:read.email`.
- **Manage Distribution**: activate public distribution, so other workspaces can
  install it.
- **Interactivity**: leave off. It carries the Merge button, which exists only at
  autonomy L4 and needs the worker at a public URL. The default, L3, opens pull
  requests for a person to merge on GitHub.

Set `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` on Render (`pager-api`).

## 6. The worker on your Mac

Install Docker Desktop (free for personal use and small businesses) and start it.
Then, in this repository:

```bash
cp deploy/worker/worker.env.example deploy/worker/worker.env
# fill in: DATABASE_URL (Neon), PAGER_MASTER_KEY, the six GITHUB_APP_* values.
# Leave ANTHROPIC_API_KEY empty: workspaces bring their own.
deploy/worker/run-here.sh
```

It builds the sandbox image, then runs the worker with every repository command in a
container, and keeps the Mac from idle-sleeping while it runs. It reads only
`worker.env`, never the repository's `.env`. The log shows
`sandbox: DockerRunner (pager-sandbox:latest) …` when it is right. Incidents are
picked up while it runs; when the Mac sleeps they wait, and nothing is lost.

## 7. Check

```bash
pnpm launch:check --console CONSOLE --api API
```

It checks that sign-in is configured, the policy pages and operator details are
present, the pricing page loads the plans, and anonymous and unsigned requests are
refused. Every line says what it saw; exit status 1 means something must be fixed.
The worker has no public address, so it is not checked from outside.

## 8. Try it yourself

Sign up at `CONSOLE`, install the GitHub App on a test repository, connect Slack and
a monitoring source, add your own Anthropic key under Settings → Model key, add a
service, and send the test incident from Setup.

## Taking payments, later

The billing code is in place (Dodo Payments: checkout, customer portal, signed
webhooks), and stays off until its variables are set. Turning it on means spending
money, so it waits for revenue:

1. Move the console off Vercel Hobby, which is for non-commercial use only.
2. In Dodo, test mode first: a monthly "Team" product at your price, an API key, and
   a webhook to `API/webhooks/dodo` subscribed to `subscription.*` and `payment.*`.
3. On Render: `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_SECRET`,
   `DODO_PAYMENTS_ENVIRONMENT=test_mode`, `DODO_PRODUCT_TEAM` (the `pdt_…` id).
4. `pnpm launch:check --console CONSOLE --api API --payments`, then buy Team with
   Dodo's test card and cancel it from Manage billing.
5. Have `/terms`, `/privacy` and `/refunds` reviewed (they commit you to a 14-day
   refund window and 30-day deletion), pass Dodo's business verification, then switch
   to live-mode keys, product and webhook.

For a worker that does not depend on your Mac, `deploy/worker/compose.yaml` runs it
on any Linux server with Docker, with Caddy in front.

## Known limits

- The worker runs only while your Mac is awake.
- Rate limits are in memory, per API instance.
- The master key is an environment variable (no KMS).
- Plan limits (Free: 1 service, 10 incidents a month) are the seeded values in
  `plans`. Change them in the database.
