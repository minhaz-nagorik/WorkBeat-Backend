## Why

The API runs on several instances, so an in-process timer would run every job once per instance
(Plan-v3.5 §3 "Scheduled jobs"). All scheduled work is a `/cron/*` route called by the scheduler
with a shared secret, in `system` scope (B10, Plan-v3.5 §6.4). Data must also leave on time: each
company keeps activity and screenshots for its own `data_retention_days`, 30, 60 or 90 (B13, PRD
"Retention and suspension").

## What Changes

- **Cron routes**: `POST /cron/<job>` with `X-Cron-Secret` compared in constant time, `system`
  scope, one advisory lock per job, safe to run twice, one log line per run.
- **Token expiry** (`/cron/token-expiry`, hourly): deletes expired, unused enrollment tokens.
- **Retention cleanup** (`/cron/cleanup`, daily 02:00 UTC): creates future partitions, deletes
  each company's activity, screenshots and their Storage objects past retention, old
  `ingest_batches` and resolved tamper events, and drops partitions that ended more than 90 days ago (the longest retention, B13).
- `/cron/heartbeat-check`, `/cron/domain-verify` and the alert digests use this mechanism; their
  logic stays in their own changes.

## Capabilities

### New Capabilities

- `cron-routes`: the scheduler's authentication, scope, locking, logging and the job list.
- `data-retention`: what `/cron/cleanup` deletes, in what order and what it never deletes.

### Modified Capabilities

None.

## Impact

- A scheduler on the server (cron or a systemd timer running `curl`) calls the routes; the secret is in the API's
  environment (establish-api-foundation 1.2).
- Jobs specified elsewhere: `offline-detection` (receive-device-health), `custom-domains`
  (configure-company), `alert-emails` (process-tamper-alerts).
- Schema: `0002_spec_gaps.sql` adds `cron_ensure_month_partitions()` and
  `cron_drop_old_partitions()`, which run as the owner and only in `system` scope.
- Object storage (B26): screenshot objects are deleted with their rows.
