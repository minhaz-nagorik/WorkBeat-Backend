## Purpose

How the scheduler runs WorkBeat's periodic work: authenticated `/cron/*` routes in `system` scope,
one run per job at a time, safe to repeat, each run logged.

## ADDED Requirements

### Requirement: Scheduled work runs only through cron routes
<!-- source: B10 · Plan-v3.5 §3 "Scheduled jobs" · Plan-v3.5 §6.4 -->
Every scheduled job SHALL be a `POST /cron/<job>` route called by Supabase pg_cron or Cloud Scheduler: `heartbeat-check` and `domain-verify` every 5 minutes, `token-expiry` hourly, `cleanup` daily at 02:00 UTC, and the digest jobs of `alert-emails`. The API MUST NOT run a job from an in-process timer.

#### Scenario: Three API instances are running
- **WHEN** 02:00 UTC passes with three instances up
- **THEN** cleanup runs only because the scheduler called `POST /cron/cleanup`, once

#### Scenario: An unknown job name
- **WHEN** `POST /cron/does-not-exist` carries the valid secret
- **THEN** the response is `404` with `code` `NOT_FOUND` and nothing runs

### Requirement: Cron routes need the shared secret
<!-- source: B10 · PRD "Security controls" · Plan-v3.5 §5.3 "Secret" -->
A cron route SHALL accept only an `X-Cron-Secret` header equal to the configured secret, compared in constant time. A missing or wrong secret MUST get `401 UNAUTHENTICATED` and run nothing; a user JWT, device key or licence key MUST NOT be accepted. The secret MUST NOT be logged.

#### Scenario: A company admin calls a cron route
- **WHEN** `POST /cron/cleanup` carries a valid company admin JWT and no `X-Cron-Secret`
- **THEN** the response is `401` with `code` `UNAUTHENTICATED`
- **AND** no row is deleted

#### Scenario: A secret of a different length
- **WHEN** `X-Cron-Secret` is a prefix of the configured secret
- **THEN** the response is `401` with `code` `UNAUTHENTICATED` and the comparison does not throw

#### Scenario: The secret in the query string
- **WHEN** the secret is sent as `?secret=` instead of the header
- **THEN** the response is `401` with `code` `UNAUTHENTICATED`

#### Scenario: Secret rotation
- **WHEN** the configured secret is replaced and the scheduler still sends the old one
- **THEN** every call answers `401 UNAUTHENTICATED` until the scheduler is updated

### Requirement: Cron routes run in system scope
<!-- source: B2 · B10 -->
A cron route SHALL set `app.scope` = `system` and no `app.company_id` before its first query. No route outside `/cron/*` MUST set `system` scope.

#### Scenario: Token expiry sees every company
- **WHEN** `/cron/token-expiry` runs
- **THEN** it reads expired tokens of every company in one run

#### Scenario: A batch transaction of cleanup
- **WHEN** `/cron/cleanup` opens its tenth batch transaction
- **THEN** that transaction sets `app.scope` = `system` before its first query and carries no `app.company_id`

### Requirement: A job runs once at a time and is safe to repeat
<!-- source: Plan-v3.5 §6.4 · D13 -->
Every transaction of a job run SHALL first take `pg_try_advisory_xact_lock` for that job. When the lock is held the run MUST stop and return `200` with `skipped` = `true`. Running a job twice in a row MUST leave the same state as running it once.

#### Scenario: The scheduler retries during a run
- **WHEN** `POST /cron/heartbeat-check` arrives while a previous run holds the lock
- **THEN** the second call returns `200` with `skipped` = `true` and changes nothing

#### Scenario: The scheduler fires the same job twice at once
- **WHEN** two `POST /cron/token-expiry` calls arrive in the same second
- **THEN** one runs and the other returns `200` with `skipped` = `true`

#### Scenario: Different jobs at the same time
- **WHEN** `/cron/heartbeat-check` and `/cron/domain-verify` run at the same moment
- **THEN** neither is skipped, because each job has its own lock

#### Scenario: A run that failed is retried
- **WHEN** a `/cron/heartbeat-check` run answers `500` after part of its work and the scheduler calls again
- **THEN** the second run finishes the work and no event or row is written twice

#### Scenario: A run longer than the interval
- **WHEN** a `/cron/heartbeat-check` run is still going when the next 5-minute call arrives
- **THEN** the new call answers `skipped` = `true` and the job runs again at the following call

### Requirement: Each run is reported and logged
<!-- source: Plan-v3.5 §3 · establish-api-foundation `api-logging` -->
A cron route SHALL return `200` with `{ data: { job, started_at, duration_ms, rows_affected, skipped, more } }` and write one log line with the job name, duration, rows affected per table and whether it was skipped. A failed run MUST return `500 INTERNAL` and log the job name and error class, never row values.

#### Scenario: A cleanup run finishes
- **WHEN** `/cron/cleanup` deletes rows from three tables
- **THEN** the response and the log line carry the count per table and the duration

#### Scenario: A skipped run
- **WHEN** a run is skipped because the lock is held
- **THEN** the response has `skipped` = `true`, `rows_affected` empty and `more` = `false`, and one log line says it was skipped

### Requirement: Expired enrollment tokens are deleted hourly
<!-- source: D43 · Plan-v3.5 §6.4 · data-model.md "enrollment_tokens" -->
`POST /cron/token-expiry` SHALL delete every `enrollment_tokens` row with `used_at` NULL and `expires_at` before now. A used token MUST NOT be deleted, because `devices.enrollment_token_id` references it.

#### Scenario: An unused token is 25 hours old
- **WHEN** `/cron/token-expiry` runs and a token expired an hour ago unused
- **THEN** the row is deleted, and presenting that token answers `404 ENROLLMENT_TOKEN_INVALID`

#### Scenario: A token at its expiry instant
- **WHEN** a token's `expires_at` equals the run's start time
- **THEN** it is not deleted by that run

#### Scenario: No expired tokens
- **WHEN** no token has expired
- **THEN** the run returns `rows_affected` 0
