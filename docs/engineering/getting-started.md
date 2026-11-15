# Getting started

What you need on your machine to work on the backend, and the commands that work today. The
repository holds only `db/` and `docs/` so far; `apps/api` and `packages/shared` arrive with change 1
(`establish-api-foundation`, task 1.1). Commands for them are marked **once `apps/api` exists**.

## You need

| Tool | Version | How to install | Why |
|---|---|---|---|
| Node.js | **20 LTS** | nodejs.org installer or `nvm install 20` | The API's runtime (Plan §3, CLAUDE.md). Node 20 left upstream support in April 2026, so moving to 22 is a decision to take (not yet in [open-questions.md](../decisions/open-questions.md)) |
| pnpm | **9.x** | `corepack enable && corepack prepare pnpm@9 --activate` | Workspaces for `apps/api` and `packages/shared` (B1). See below |
| PostgreSQL | **15 or later** (`psql` client and server) | `brew install postgresql@15`, or use the Supabase CLI | Supabase runs PostgreSQL 15+; CI applies migrations to 15. Checked locally on 17 |
| Supabase CLI | current | `brew install supabase/tap/supabase` | Optional. A local Supabase stack (Postgres, Auth, Storage, pg_cron) when you need more than plain Postgres |
| OpenSpec CLI | 1.9.0 tested | `npm i -g @fission-ai/openspec` | `openspec validate --all --strict` is a merge gate (CLAUDE.md rule 10) |
| Docker | current | Docker Desktop | Only for the Supabase CLI and the integration tests |

### Why pnpm, not npm workspaces

| | pnpm | npm workspaces |
|---|---|---|
| Undeclared dependencies | Fail: each package sees only what it declares | Work by accident through hoisting |
| Linking `packages/shared` | `workspace:*`, never published | `*`, easy to resolve from the registry by mistake |
| CI install time | Content-addressed store, fast cached installs | Slower on cold caches |

The first row matters most: `packages/shared` is consumed by the web platform and, as exported
schemas, by both agents. A phantom dependency that works here and breaks there is exactly the
failure we want CI to catch.

## Clone and install

```bash
git clone <backend repo> WorkBeat-Backend && cd WorkBeat-Backend
git switch dev-<your-name>        # see git-workflow.md
pnpm install                      # once apps/api exists
```

## Database: migrations and self-checks

Create an empty database and run the two migrations, then each self-check. The migrations create
the `workbeat_api` role and extensions, so connect as a superuser (the default `postgres` user
locally).

```bash
createdb workbeat_dev
export PGDATABASE=workbeat_dev

psql -v ON_ERROR_STOP=1 -f db/migrations/0001_init.sql -f db/migrations/0002_spec_gaps.sql
psql -v ON_ERROR_STOP=1 -f db/tests/0001_init_test.sql
psql -v ON_ERROR_STOP=1 -f db/tests/0002_spec_gaps_test.sql
```

Each self-check runs as `workbeat_api` inside one transaction that is rolled back, so it leaves
the database as it found it and can be run again. A pass prints `NOTICE: ok …` lines and exits
`0`; a failure stops at the first `FAIL: …` with a non-zero exit. Checked on 15 Nov 2026: 49 checks
in `0001`, 22 in `0002`, all pass.

To start again: `dropdb workbeat_dev && createdb workbeat_dev`.

### With the Supabase CLI instead

```bash
supabase start                    # prints the local DB URL (port 54322)
export PGHOST=127.0.0.1 PGPORT=54322 PGUSER=postgres PGPASSWORD=postgres PGDATABASE=postgres
# then the same four psql commands as above
```

Use this when you need Auth or Storage locally. Plain Postgres is enough for schema work.

## Run the API (once `apps/api` exists)

These are the planned commands; the scripts are defined in change 1.

```bash
cp apps/api/.env.example apps/api/.env      # values: environments-and-config.md
pnpm --filter @workbeat/api db:migrate      # migration runner (schema-migrations, task 6.1)
pnpm --filter @workbeat/api dev             # http://localhost:3000
curl -s localhost:3000/health               # 200 when the database answers
pnpm -r lint typecheck test                 # what CI runs before integration tests
```

The API reads its configuration from the environment and refuses to start when a value is
missing ([environments-and-config.md](environments-and-config.md)).

## Validate the specs

```bash
cd docs && openspec validate --all --strict
```

Run every `openspec` command from `docs/`. Today all 14 changes pass.

## Before your first PR

Read [../../CLAUDE.md](../../CLAUDE.md), [../BUILD-ORDER.md](../BUILD-ORDER.md),
[agent-contract.md](../core/api/agent-contract.md), [data-model.md](../core/architecture/data-model.md)
and the change you are working on (`openspec show <change-id>`).

## What you will get wrong if you skip the docs

- Taking `company_id` from a request body "just for this admin route" (rule 1).
- Querying outside the request transaction, so `app.scope` is unset and the query silently
  returns nothing (B2).
- Logging a request body to debug a `422`. Bodies carry URLs, titles and keys (rule 4).
- Adding a `setInterval` for a cleanup task. Scheduled work is `/cron/*` only (rule 8).
- Editing `0001_init.sql` because "nobody has applied it yet". Add `0003_…` instead (rule 9).
