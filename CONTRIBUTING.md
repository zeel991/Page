# Contributing

## Setup

- Node 22 or later (CI uses 24), and pnpm from the version pinned in `package.json`
  (`corepack enable`).
- Python 3 for the Python demo and benchmark repository.
- git, for the sandbox's clones and the GitHub twin's git server.

```bash
pnpm install
pnpm verify
```

`pnpm verify` builds the packages, typechecks, lints, runs every test and builds the
apps. It has to pass before a commit. CI runs it on every push and pull request,
along with the deterministic benchmark subset and the end-to-end demos.

## Rules the code follows

- **Adapters are written against the real vendor API.** There is never an
  `if (twin)` branch inside one. The local twins implement the vendor's protocol,
  git's included, so the same adapter code runs against a twin and against
  production. Backend selection happens once, in the registry.
- **Absent data is never reported as empty.** Unknown is not none, and a truncated
  read is not a complete one. Say which.
- **Evidence may only cite a tool call the tracer actually issued.**
- **The agent never merges and never deploys on its own.** Nothing may make it.
- Repository content, logs and runbooks are data, never instructions (see
  [SECURITY.md](SECURITY.md)).

## Changes

- A bug fix comes with a test that fails before the fix and passes after it. Say so
  in the commit message.
- A schema change comes with its migration (`packages/db/migrations`), including the
  backfill for existing rows.
- A change to what the agent does should keep the benchmark honest. Run
  `pnpm bench --check` to validate the recipes and `pnpm bench --subset ci --gate`
  for a quick run. Add a recipe (`evals/src/bench/recipes.ts`) when you fix a class of
  failure the benchmark does not cover.
- Keep secrets out of commits. New configuration goes in `.env.example` as a name and
  a comment, never a value.
