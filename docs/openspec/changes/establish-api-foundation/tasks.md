> **Read first — this task list is not the requirement.**
> Capabilities: `api-envelope · request-scope · api-logging · rate-limiting · schema-migrations`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show establish-api-foundation`.
> Contract: [agent-contract.md](../../../core/api/agent-contract.md) · Schema: [data-model.md](../../../core/architecture/data-model.md).

## 1. Repository

- [ ] 1.1 Workspace with `apps/api` (NestJS 10, Fastify adapter, Node 20) and `packages/shared` (zod) (B1)
- [x] 1.2 Config from the environment, validated at start: database URL, encryption key (B6), storage directory (B26), cron secret (B10), Stripe and Resend keys
- [ ] 1.3 CI: lint, typecheck, unit tests, migrations + self-checks on PostgreSQL 15, `openspec validate --all --strict`

## 2. api-envelope

- [ ] 2.1 Response interceptor `{ data }`; exception filter `{ error, code }` with the status per code
- [ ] 2.2 Code catalog and per-route body limits in `packages/shared`
- [ ] 2.3 zod validation pipe: 400 / 422 `VALIDATION_FAILED` with field names; unknown fields stripped
- [ ] 2.4 `Date` and `X-Request-Id` on every response, echoing the client's ID
- [ ] 2.5 Tests: unhandled error → 500 `INTERNAL` with no SQL; oversized body → 413; echo of `X-Request-Id`

## 3. request-scope

- [ ] 3.1 Per-request transaction on the pooler (transaction mode) with `SET LOCAL app.scope` and `app.company_id` (B2)
- [ ] 3.2 Repository layer that cannot run a query outside the request transaction
- [ ] 3.3 Credential resolvers calling the `auth_*` and `company_by_host` functions with SHA-256 hashes (B3)
- [ ] 3.4 Tests: body `company_id` ignored; staff scope reads no `devices`; unscoped query returns nothing; two tenants in parallel never see each other's rows

## 4. api-logging

- [ ] 4.1 JSON logger with request ID, route pattern, status, code, duration, scope, company and device IDs
- [ ] 4.2 Redaction list for headers and fields; bodies are never logged
- [ ] 4.3 Test: grep logs of a full enroll → heartbeat → activity run for every secret and URL used — no match

## 5. rate-limiting

- [ ] 5.1 Limiter keyed by device key hash, licence key hash, user ID and IP, with limits from `packages/shared`
- [ ] 5.2 `429 RATE_LIMITED` with `Retry-After`
- [ ] 5.3 Tests: agent cadence × 3 passes; validation brute force is cut off

## 6. schema-migrations

- [ ] 6.1 Migration runner applying `db/migrations/*.sql` in order inside a transaction, recording applied files
- [ ] 6.2 `GET /health` with a `SELECT 1` and a short timeout
- [ ] 6.3 Tests: fresh database → all self-checks pass; applied migration edited → runner refuses
