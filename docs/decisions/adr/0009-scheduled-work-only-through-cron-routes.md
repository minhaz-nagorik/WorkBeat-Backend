# ADR 0009 — Run scheduled work only through cron routes

**Status:** Accepted
**Date:** 2026-11-15

## Context

The backend has periodic work: offline detection and custom-domain checks every 5 minutes,
expired enrollment token cleanup hourly, retention cleanup daily at 02:00 (Plan-v3.2 §6.4), and
the alert digest hourly (process-tamper-alerts design). The API runs as several container
instances. An in-process NestJS scheduler would run each job once per instance (Plan §3), and a
job that runs twice at once can double-send an email or race its own deletes. Jobs must see every
company, which is `system` scope (ADR 0003), and nothing else may get that scope.

## Decision

Every scheduled job is a `POST /cron/<job>` route called by Supabase pg_cron or Cloud Scheduler;
nothing runs on an in-process timer (Plan §3). A cron route accepts only an `X-Cron-Secret` header
equal to the configured secret, compared in constant time; a user JWT, device key or licence key
never authenticates it (B10). It sets `app.scope` = `system` and no `app.company_id` before its
first query, and no route outside `/cron/*` may set `system`. Every transaction of a run first
takes `pg_try_advisory_xact_lock` for its job; when the lock is held the run stops and answers
`200` with `skipped` = `true`. Transaction locks, not session locks, because session locks are
unsafe on the transaction-mode pooler. Every job is idempotent: running it twice leaves the same
state as running it once, so a retry or an overlap is harmless. `/cron/cleanup` commits in batches
and stops at a time budget, answering `more: true` (B15).

## Consequences

A job runs once per schedule however many instances are up, and scaling the API changes nothing.
A job can be run by hand with the secret, which makes testing and recovery simple. The schedule
lives outside the code, in the scheduler. The cost: one shared secret guards every `system` route,
so it must be rotated and never logged; a scheduler outage stops every job, and offline alerts
stop with it; and the scheduler, not the API, must be configured per environment.

## Alternatives considered

| Option | Why not |
|---|---|
| NestJS `@nestjs/schedule` in the API | Runs once per instance (Plan §3) |
| A single dedicated worker process | One more deploy and still needs a lock for a second copy during a rollout |
| Session advisory locks | Unsafe on the Supavisor transaction-mode pooler |
| pg_cron calling SQL functions directly | Jobs also send email and delete Storage objects, which live in the API |
| Authenticate cron with a staff JWT | Staff scope must never reach employee data (D41); cron needs `system` |

## Rejected explicitly

Any in-process timer, interval or queue consumer that does scheduled work (CLAUDE.md rule 8).

## Links

- Decisions: [B10, B15](../backend-decisions.md), Plan-v3.2 §3, §6.4.
- Design: [run-scheduled-jobs](../../openspec/changes/run-scheduled-jobs/design.md).
- Specs: [cron-routes](../../openspec/changes/run-scheduled-jobs/specs/cron-routes/spec.md),
  [data-retention](../../openspec/changes/run-scheduled-jobs/specs/data-retention/spec.md),
  [offline-detection](../../openspec/changes/receive-device-health/specs/offline-detection/spec.md),
  [custom-domains](../../openspec/changes/configure-company/specs/custom-domains/spec.md),
  [alert-emails](../../openspec/changes/process-tamper-alerts/specs/alert-emails/spec.md).
