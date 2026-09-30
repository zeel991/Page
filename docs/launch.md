# Launch runbook

Everything needed to take Pager Developer from this repository to open, paid sign-up.
Each step that needs an account or a secret is yours to do; nothing here asks you to
paste a secret anywhere but the service that holds it.

At the end, `pnpm launch:check` asks the running services whether they are ready.

## Topology

| Piece | Where | Why there |
| --- | --- | --- |
| Console (Next.js) | Vercel | Already deployed there |
| API + Postgres | Render (`render.yaml`) | Migrations run before each API deploy |
| Worker | A Linux VM with Docker (`deploy/worker`) | Open sign-up runs strangers' test suites; they must run in containers, and Render has no Docker daemon |
| Payments | Dodo Payments | Merchant of record: they handle tax and appear on the statement |

Hostnames used below: `CONSOLE` (e.g. `https://page-iota-six.vercel.app`), `API`
(e.g. `https://pager-api.onrender.com`) and `WORKER` (e.g. `https://worker.example.com`).

## 1. API and database on Render

1. Render → **New → Blueprint** → this repository. It creates `pager-db`, `pager-api`
   and the `pager-secrets` group (the session secret and master key are generated).
2. Fill the `sync: false` values when asked. You can leave the GitHub, Slack and
   Dodo values empty for now and set them after steps 2, 3 and 5:
   - `PAGER_WEB_ORIGIN` = `CONSOLE`
3. Once it is live, note `API`, and `curl API/health` should answer `{"status":"ok"}`.
4. From `pager-secrets`, copy `PAGER_SESSION_SECRET` (for Vercel, step 4) and
   `PAGER_MASTER_KEY` (for the worker, step 6).

## 2. The GitHub App

GitHub → Settings → Developer settings → **GitHub Apps → New GitHub App**:

| Field | Value |
| --- | --- |
| Homepage URL | `CONSOLE` |
| Callback URL | `CONSOLE/api/auth/callback/github` |
| Request user authorization (OAuth) during installation | **on** (the install is proven with it) |
| Setup URL | `CONSOLE/onboarding/github/setup` |
| Webhook URL | `API/webhooks/github`, with a generated secret |
| Repository permissions | Contents, Pull requests, Checks, Issues, Commit statuses: read & write. Metadata: read |
| Account permissions | Email addresses: read |
| Events | Push, Pull request |
| Where can it be installed | Any account |

Then generate a private key. Set on Render (`pager-api`) and in the worker's
`worker.env`: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (the whole PEM),
`GITHUB_APP_SLUG` (from the app's URL), `GITHUB_APP_CLIENT_ID`,
`GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_WEBHOOK_SECRET`.

## 3. The Slack app

api.slack.com → **Create New App** → From scratch:

- **OAuth & Permissions**: redirect URL `CONSOLE/onboarding/slack/callback`; bot
  scopes `chat:write`, `channels:read`, `groups:read`, `users:read`,
  `users:read.email`.
- **Interactivity & Shortcuts**: on, request URL `WORKER/slack/interactions`.
- **Manage Distribution**: activate public distribution, so other workspaces can install it.

Set `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` on Render (`pager-api`), and
`SLACK_SIGNING_SECRET` in `worker.env`.

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

Redeploy. The live console currently answers `/api/auth/providers` with a 500
"server configuration" error. That is Auth.js reporting a missing `AUTH_SECRET` or
GitHub client, and this step is what fixes it.

Read `/terms`, `/privacy` and `/refunds` before going live. They describe what the
code does, but they commit you to a 14-day refund window and 30-day deletion, and they
have not had a lawyer's review.

## 5. Dodo Payments

Start in **test mode**; nothing here takes real money until step 9.

1. Create the business. **Products → New product → Subscription**: "Team", monthly,
   at the price you want. The pricing page reads the price from this product, so
   Dodo is the only place it is set.
2. **Developer → API keys**: create a key. **Developer → Webhooks**: add
   `API/webhooks/dodo`, subscribed to `subscription.*` and `payment.*`; copy its
   signing secret (`whsec_…`).
3. On Render (`pager-api`): `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_SECRET`,
   `DODO_PRODUCT_TEAM` (the product id, `pdt_…`). Leave
   `DODO_PAYMENTS_ENVIRONMENT=test_mode`.
4. Optionally, check the adapter against your test account:
   `CONTRACT_DODO_API_KEY=… CONTRACT_DODO_PRODUCT=pdt_… pnpm test:contract`.

## 6. The worker on a Docker host

Any Linux VM with Docker Engine and a public DNS name (`WORKER`):

```bash
git clone https://github.com/zeel991/Page && cd Page/deploy/worker
cp worker.env.example worker.env        # fill it in: DATABASE_URL, PAGER_MASTER_KEY, GITHUB_APP_*, SLACK_SIGNING_SECRET, ANTHROPIC_API_KEY
sudo install -d -o 10001 -g 10001 /var/lib/pager/sandboxes /var/lib/pager/cache
DOCKER_GID=$(getent group docker | cut -d: -f3) WORKER_DOMAIN=worker.example.com docker compose up -d --build
```

- `DATABASE_URL` is `pager-db`'s **external** URL. Add the VM's IP to `pager-db`'s
  access control (Render → pager-db → Networking), or it cannot connect.
- The worker refuses to start with a local sandbox against a real database, and
  checks at boot that the sandbox image exists. `docker compose logs worker` shows
  `sandbox: DockerRunner (pager-sandbox:latest) …` when it is right.
- For a kernel boundary as well, install gVisor and set
  `PAGER_SANDBOX_DOCKER_RUNTIME=runsc`.
- **Model spend under open sign-up:** with `ANTHROPIC_API_KEY` set, every free
  workspace spends up to the free plan's included amount ($5 a month) on your key.
  To make free workspaces bring their own key, set that plan's
  `included_model_usd` to null:
  `update plans set included_model_usd = null where id = 'free';`

## 7. Check

```bash
pnpm launch:check --console CONSOLE --api API --worker WORKER
```

It checks that sign-in is configured, the policy pages and operator details are
present, the pricing page shows a price, billing is enabled, anonymous and unsigned
requests are refused, and the worker reports the Docker sandbox. Every line says what
it saw; exit status 1 means something must be fixed.

## 8. Try it yourself, in test mode

Sign up at `CONSOLE`, install the GitHub App on a test repository, connect Slack and
a monitoring source, add a service, and send the test incident from Setup. Then
Settings → Plan and billing → **Upgrade to Team**, pay with Dodo's test card, and
check you come back on Team. Cancel from **Manage billing**; the workspace should
return to Free.

## 9. Go live with payments

1. Complete Dodo's business verification. They review the public site: pricing,
   terms, privacy, refund policy and contact, linked from the footer. Those pages
   exist; the operator name and support address must be set (step 4).
2. Once approved, create the live-mode product, API key and webhook, the same as
   step 5. On Render, set them and `DODO_PAYMENTS_ENVIRONMENT=live_mode`.
3. Run `pnpm launch:check` again. The console's Plan and billing panel stops saying
   TEST MODE.

## Known limits at launch

- Rate limits are in memory, per API instance.
- The master key is an environment variable (no KMS).
- Plan limits (1 and 25 services; 10 and 500 incidents) are the seeded values in
  `plans`. Change them in the database.
- A workspace that drops to Free keeps the services it already has. The limit
  applies only to adding new ones.
