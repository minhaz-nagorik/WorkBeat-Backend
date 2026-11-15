# Testing strategy

**A spec scenario without a test is not done.** Each test is named after the scenario it proves,
and every `tasks.md` ends with the tests its change needs. This page says which layer each kind of
test belongs to and what blocks a merge.

## Layers

| Layer | Proves | Tool | Runs |
|---|---|---|---|
| SQL self-checks | Each migration: RLS per scope, seat trigger, constraints, `SECURITY DEFINER` lookups, grants | `psql` + `db/tests/*.sql`, as `workbeat_api`, rolled back | every PR |
| Unit | Pure logic: slug generator, key normalisation and hashing, semver compare, block-rule regex compiler, CSV formula guard, B7 window, `blocking_ends_at`, tier interval rule | Jest (or Vitest), no database | every PR |
| Integration | Routes end to end on a real PostgreSQL 15 with RLS, connected **as `workbeat_api`**, never a superuser | Jest + Fastify `inject`, Postgres in a container, migrations applied fresh | every PR |
| Contract | Every agent request and response matches the `packages/shared` zod schemas; fixtures exported as JSON Schema for both agent repositories | zod + exported fixtures | every PR |
| Security suites | Tenant isolation, staff data boundary, role matrix, log redaction | Integration harness, seeded with two companies | every PR |
| Webhook replay | Stripe events: signature, duplicates, out of order | Recorded event fixtures | every PR |
| Cron | Idempotency and locking of every `/cron/*` job | Integration harness | every PR |
| Load | Throughput and report latency at pilot scale | k6 (or similar) against staging | before the pilot, then before each schema-heavy release |

Integration tests connect as `workbeat_api` because a superuser bypasses RLS: a test that passes
as `postgres` proves nothing about isolation (B2).

## SQL self-checks

`db/tests/<number>_<name>_test.sql` per migration (rule 9). They seed two companies in `system`
scope, switch scope, and assert with `pg_temp.ok` and `pg_temp.raises`. CI applies every migration
to an empty database, then runs every self-check
([getting-started.md](getting-started.md#database-migrations-and-self-checks)).

## Contract tests

The agents rely on routes, fields, statuses and codes ([agent-contract.md](../core/api/agent-contract.md)).

- One fixture per row of the status and code catalog, generated from `packages/shared`.
- A test per agent route that the response validates against its schema, including errors.
- A snapshot of the exported JSON Schemas. A diff in the snapshot is a contract change: it needs
  a spec change here and in both agent repositories (rule 5).

## Tenant-isolation suite

Every change's tasks end with a tenant-isolation test; this suite makes the rule mechanical.

| Step | What |
|---|---|
| Seed | Companies A and B, each with users of every role, employees, devices, activity, screenshots, alerts, rules |
| Enumerate | Every registered read route (from the route table, so a new route is included automatically) |
| Call | Each route as A's user for A's IDs, then for B's IDs |
| Expect | A sees only A; B's IDs give `404 NOT_FOUND`; list counts match A's seed exactly |
| Parallel | A and B requests interleaved on the same pool, to catch a scope left on a pooled connection |

A route that is not covered fails the suite.

## Staff data boundary (CI)

`staff-data-boundary` specifies this test, so it is a gate, not an option:

- A `super_admin` token (at `aal2`) calls every staff route and every company route.
- Company routes must answer `403 FORBIDDEN`.
- Staff responses are searched for every seeded employee name, email, hostname, serial, URL, domain,
  window title and screenshot path. Any match fails the build.
- In `staff` scope, `SELECT` on every tenant table returns zero rows.

## Role matrix

The permission matrix is one table in `packages/shared` (`role-access` task 2.1). The test reads
that table and calls each route as `company_admin`, `manager`, `it_admin`, `super_admin` and no
token, expecting the matrix answer. Managers are also tested against an employee of another
manager (`404`).

## Stripe webhook replay

| Case | Expected |
|---|---|
| Same event twice | One company, second call `200` with no handler run |
| Bad or missing signature | `400 WEBHOOK_SIGNATURE_INVALID`, nothing in `stripe_events` |
| Events out of order | Licence matches the subscription Stripe returns now |
| `invoice.paid` after a staff suspension | Still suspended |

Fixtures are recorded from Stripe test mode with `stripe trigger` and replayed with a test
signing secret.

## Cron idempotency

For each of `heartbeat-check`, `domain-verify`, `token-expiry`, `cleanup`, `alert-digest`:

- No secret, wrong secret, a user JWT → `401`, nothing changes.
- Two concurrent calls → one runs, the other returns `skipped: true`.
- Run twice → same state as once.
- Cleanup with a tiny time budget → `more: true`, and the next run finishes the work.

## Log redaction

One test runs enroll → heartbeat → activity → screenshot → reveal, captures every log line, and
greps for every secret, URL, title and signed URL used (`api-logging` task 4.3). Any match fails.

## Load test

| | Value |
|---|---|
| Target | 5,000 simulated devices (Plan §6.3, pilot phase gate in Plan §7) |
| Cadence per device | Heartbeat every 5 min, batch every 10 min, policy every 30 min |
| Steady rate | About 28 requests per second (1/300 + 1/600 + 1/1800 per device) |
| Upper bound | 555 req/s at 100,000 employees (Plan §6.3); the test should show headroom toward it |
| Also measured | Every report < 1 s for one employee-week (`usage-reports` 2.6); one night's cleanup within budget (`data-retention` 3.5) |

Run it against staging with a seeded data set, never production.

## What gates a merge

| Gate | Fails when |
|---|---|
| Lint and typecheck | Any error |
| Unit, integration, contract, security suites, webhook, cron | Any failure |
| Migrations + self-checks on PostgreSQL 15 | Any `FAIL:` or a non-zero exit |
| Migration runner | An applied migration's content changed |
| `cd docs && openspec validate --all --strict` | Any invalid change |
| Review | The [PR checklist](git-workflow.md#pr-checklist) is not ticked |

The load test gates the pilot, not each merge.
