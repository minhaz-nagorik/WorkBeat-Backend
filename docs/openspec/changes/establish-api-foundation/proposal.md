## Why

Every later change needs the same skeleton: one response envelope the agents already branch on, a
request transaction that fixes the tenant before the first query (Plan-v3.2 §6.1, B2), logs that
never hold a secret, and migrations that apply the same way everywhere. Getting the scope wrong is
the one failure that leaks a company's data to another (Plan-v3.2 §8 "Tenant data leak").

## What Changes

- **One envelope** for every route: `{ data }` on success, `{ error, code }` on failure, with the
  status and code catalog in `agent-contract.md` (B9).
- **Every request runs in one database transaction** that sets `app.scope` and, for a tenant,
  `app.company_id` before any query; nothing runs outside it (B2).
- **Structured logs** with a request ID on every line and no secret at any level.
- **Rate limits** per device key, licence key, user and, on unauthenticated routes, client IP,
  answered with `429 RATE_LIMITED`.
- **One success-status convention**: `201` create, `200` read, update or action, `204` delete.
- **Numbered migrations** applied in order, each with a self-check, and a health route.

## Capabilities

### New Capabilities

- `api-envelope`: response shape, error codes, request ID, `Date` header, validation errors.
- `request-scope`: the per-request transaction and its scope, and what happens without one.
- `api-logging`: what is logged, what never is.
- `rate-limiting`: limits per credential and the `429` answer.
- `schema-migrations`: how the schema is applied and checked, and the health route.

### Modified Capabilities

None.

## Impact

- Consumed by both agents and the Downloader: the envelope, `Date` header and status table in
  their `status-code-handling.md`.
- Every later change depends on this one.
- Schema: `db/migrations/0001_init.sql` and `db/tests/0001_init_test.sql`.
