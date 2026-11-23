# Scheduled jobs

All periodic work is a `POST /cron/<job>` route on the API, called by the scheduler with the
`X-Cron-Secret` header (B10). There are no in-process timers: with three instances they would run
three times (rule 8). The mechanism is specified in `run-scheduled-jobs` (`cron-routes`).

## The jobs

| Route | Schedule (UTC) | Does | Owning change | Expected runtime |
|---|---|---|---|---|
| `/cron/token-expiry` | `0 * * * *` | Deletes unused enrollment tokens past `expires_at`; used tokens stay | `run-scheduled-jobs` (`cron-routes`) | Under a second |
| `/cron/usage-summary` | `0 * * * *` | Deletes each company's summaries past retention, then builds the summary of every finished company day not built yet, newest first | `summarize-usage` (`usage-summaries`) | Seconds once caught up; after deploy or a timezone change it backfills up to 90 days per company and returns `more: true` until done |
| `/cron/cleanup` | `0 2 * * *` | Ensures monthly partitions, deletes each company's activity and screenshots past retention in batches, deletes old `ingest_batches` and resolved old tamper events, drops partitions past 90 days (screenshots not yet, task 3.2) | `run-scheduled-jobs` (`data-retention`) | Up to the time budget in `packages/shared`; may return `more: true` |

Runtimes are expectations until the load test measures them (`data-retention` task 3.5).

There is no `/cron/heartbeat-check` and no `/cron/alert-digest` (B34). A device shows as `offline`
when its last heartbeat is over 15 minutes old, worked out at read time; there are no alert emails.
If many devices show offline at once, it is usually the API, not the devices: check API errors and
heartbeat `5xx` first.

## What every run returns

```json
{ "data": { "job": "cleanup", "started_at": "…", "duration_ms": 41230,
            "rows_affected": { "app_sessions": 120344, "screenshots": 812 },
            "skipped": false, "more": false } }
```

| Field | Read it as |
|---|---|
| `skipped: true` | Another run held the advisory lock. Normal if runs overlap; a problem if every run skips |
| `more: true` | Cleanup spent its budget. The service calls it again at once, up to 12 calls a night. If the 12th still says `more: true`, the budget or batch size is too small |
| `500 INTERNAL` | The run failed. The log line has the job name and error class, never row values |
| `401` | The scheduler's secret does not match the API's `CRON_SECRET` |

Every job is safe to repeat and safe to call by hand with the secret.

All three are built: `/cron/usage-summary` (summarize-usage), `/cron/token-expiry` (cron-routes) and `/cron/cleanup` (data-retention, screenshots and their R2 files included). Any other job name answers `404`.

## When a job fails

| Job | Symptom | Check |
|---|---|---|
| any | `401` | Secret in Vault / Cloud Scheduler equals `CRON_SECRET`; no stray whitespace; rotated on both sides |
| any | No log line at all | Scheduler job exists and is active; `net._http_response` (pg_net) or Cloud Scheduler's last attempt; API host reachable from the scheduler |
| any | Always `skipped` | A run is stuck holding the lock: look for a long transaction in `pg_stat_activity` and end it |
| `token-expiry` | Validated-but-unused tokens pile up | Harmless for 24 h; check the job is scheduled |
| `usage-summary` | Reports slow for past days | `more: true` on every run: the backfill is not done; `usage_days` has no row for those days |
| `cleanup` | `more: true` every night | Raise the budget or batch size in `packages/shared` (a release); check for missing indexes after a migration |
| `cleanup` | Screenshot rows not shrinking | Storage deletes failing: rows are kept on purpose until the object is gone |
| `cleanup` | Partition errors | Next month's partitions missing means inserts will fail on the 1st: run cleanup by hand now |

Running a job by hand:

```bash
curl -fsS -X POST https://<api host>/cron/cleanup -H "X-Cron-Secret: $CRON_SECRET"
```

Never paste the secret into a ticket or chat; read it from the secret store into the variable.

## Setting up the schedule (systemd timers)

The database is self-hosted PostgreSQL (B22, no Supabase), so there is no pg_cron/Vault setup.
One host runs systemd timers that `curl` each route; the units and install steps are in
[`db/cron/`](../../db/cron/README.md). The secret lives only in the root-only
`/etc/workbeat/cron.env`, never in a unit file.

| Check | Command |
|---|---|
| Timers defined and next run | `systemctl list-timers 'workbeat-cron@*'` |
| Last runs and answers | `journalctl -u 'workbeat-cron@cleanup.service' -n 20` |
| Run one now | `sudo systemctl start workbeat-cron@cleanup.service` |

`curl --max-time 900` outlasts cleanup's 5-minute budget. Run timers on one host only: a second
scheduler is harmless (the lock skips it) but makes failures hard to read.
