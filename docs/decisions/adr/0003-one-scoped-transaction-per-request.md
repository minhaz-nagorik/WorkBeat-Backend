# ADR 0003 — Run every request in one scoped transaction

**Status:** Accepted
**Date:** 2026-11-15
**Amends:** Plan-v3.2 §6.1, which says the API connects with a server connection that bypasses
row-level security and keeps RLS only as a recommended extra.

## Context

Every tenant table holds one company's data beside every other company's. One missed
`WHERE company_id = …` in a report or a repository would show a company another company's
employees, URLs or screenshots. Plan §6.1 puts isolation in the API and recommends RLS as defence
in depth. Staff must never read employee data (D41), and cron jobs must see every company. The API
connects through the Supavisor pooler in transaction mode, so session settings do not survive
between transactions.

## Decision

Every request that touches the database runs in exactly one transaction that, before its first
query, runs `SET LOCAL app.scope` = `tenant`, `staff` or `system` and, in `tenant` scope,
`SET LOCAL app.company_id` from the credential, never the body (B2). The API connects as
`workbeat_api`, which is subject to RLS; it does not bypass it. Every tenant table has a policy on
`app_company_id()` and `app_scope()`: `tenant` sees its company, `staff` sees only `companies`,
`licenses`, `users`, `invitations` and the global tables, `system` sees everything, and an unset
scope sees nothing. Only `/cron/*` routes set `system` (ADR 0009). Monthly partitions are never
granted to `workbeat_api`, so the API reaches them only through the parent table and its policy.
The guards and query layer still add `company_id` themselves; RLS is the backstop, not the control.

**Exception (B15):** `/cron/cleanup` commits each delete batch in its own short transaction. Each
batch transaction still sets `app.scope` = `system` first, so no query ever runs without a scope.

## Consequences

A missed filter returns nothing instead of another company's rows, and a forgotten scope returns
nothing at all. Staff isolation (D41) is enforced by the database as well as the routes.
`SET LOCAL` is safe on the transaction-mode pooler because it dies with the transaction. The cost:
a request cannot stream across transactions, long work must be split (B15, the synchronous CSV cap
in report-usage), every query pays the RLS predicate, and credential lookups before a tenant is
known need a narrow route around RLS (ADR 0004).

## Alternatives considered

| Option | Why not |
|---|---|
| Bypass-RLS connection, isolation in the API only (Plan §6.1 as written) | One missed filter leaks a tenant; nothing catches it |
| RLS on Supabase JWT claims | Devices, the Downloader and cron carry no Supabase JWT |
| One schema or database per company | Migrations, partitions and pooling multiply by the company count |
| Session-level `SET` | Leaks between clients on the transaction-mode pooler |

## Rejected explicitly

Granting `workbeat_api` `BYPASSRLS`, or granting it direct access to a partition.

## Links

- Decisions: [B2, B15](../backend-decisions.md), D41, Plan-v3.2 §6.1; CLAUDE.md rules 1–3.
- Schema: [0001_init.sql](../../../db/migrations/0001_init.sql) "row-level security".
- Specs: [request-scope](../../openspec/changes/establish-api-foundation/specs/request-scope/spec.md),
  [staff-data-boundary](../../openspec/changes/administer-platform/specs/staff-data-boundary/spec.md),
  [cron-routes](../../openspec/changes/run-scheduled-jobs/specs/cron-routes/spec.md),
  [data-retention](../../openspec/changes/run-scheduled-jobs/specs/data-retention/spec.md).
