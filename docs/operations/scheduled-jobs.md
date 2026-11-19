# Scheduled jobs

All periodic work is a `POST /cron/<job>` route on the API, called by the scheduler with the
`X-Cron-Secret` header (B10). There are no in-process timers: with three instances they would run
three times (rule 8). The mechanism is specified in `run-scheduled-jobs` (`cron-routes`).

## The jobs

| Route | Schedule (UTC) | Does | Owning change | Expected runtime |
|---|---|---|---|---|
| `/cron/heartbeat-check` | `*/5 * * * *` | Marks devices silent for over 15 min `offline` and raises one `offline` event each; skips released, deactivated and ended devices; hands new events to alert emails | `receive-device-health` (`offline-detection`) | Seconds: one `UPDATE … RETURNING` plus inserts |
| `/cron/domain-verify` | `*/5 * * * *` | Looks up TXT `_workbeat.{domain}` for every `pending` custom domain; `active` on match, `failed` after the cut-off | `configure-company` (`custom-domains`) | Seconds; bounded by the per-lookup DNS timeout × pending domains |
| `/cron/token-expiry` | `0 * * * *` | Deletes unused enrollment tokens past `expires_at`; used tokens stay | `run-scheduled-jobs` (`cron-routes`) | Under a second |
| `/cron/alert-digest` | `0 * * * *` | Hourly digests; daily digests at the run that falls at 09:00 in each company's `timezone`; retries failed instant emails under 24 h old | `process-tamper-alerts` (`alert-emails`) | Seconds; one Resend call per recipient |
| `/cron/cleanup` | `0 2 * * *` | Ensures monthly partitions, deletes each company's activity and screenshots past retention in batches, deletes old `ingest_batches` and resolved old tamper events, drops partitions past 90 days | `run-scheduled-jobs` (`data-retention`) | Up to the time budget in `packages/shared`; may return `more: true` |

Runtimes are expectations until the load test measures them (`data-retention` task 3.5).

## What every run returns

```json
{ "data": { "job": "cleanup", "started_at": "…", "duration_ms": 41230,
            "rows_affected": { "app_sessions": 120344, "screenshots": 812 },
            "skipped": false, "more": false } }
```

| Field | Read it as |
|---|---|
| `skipped: true` | Another run held the advisory lock. Normal if runs overlap; a problem if every run skips |
| `more: true` | Cleanup spent its budget. The next night continues. Several nights in a row means the budget or batch size is too small |
| `500 INTERNAL` | The run failed. The log line has the job name and error class, never row values |
| `401` | The scheduler's secret does not match the API's `CRON_SECRET` |

Every job is safe to repeat and safe to call by hand with the secret.

## When a job fails

| Job | Symptom | Check |
|---|---|---|
| any | `401` | Secret in Vault / Cloud Scheduler equals `CRON_SECRET`; no stray whitespace; rotated on both sides |
| any | No log line at all | Scheduler job exists and is active; `net._http_response` (pg_net) or Cloud Scheduler's last attempt; API host reachable from the scheduler |
| any | Always `skipped` | A run is stuck holding the lock: look for a long transaction in `pg_stat_activity` and end it |
| `heartbeat-check` | Offline alerts late or missing | Job runs every 5 min; devices' `last_heartbeat_at` moving; the 15 min threshold in `packages/shared` |
| `heartbeat-check` | Many devices offline at once | Usually the API, not the devices: check API errors and heartbeat `5xx` first |
| `domain-verify` | Domains stay `pending` | DNS timeouts in the log; the customer's TXT record with `dig TXT _workbeat.<domain>` |
| `token-expiry` | Validated-but-unused tokens pile up | Harmless for 24 h; check the job is scheduled |
| `alert-digest` | No emails | Resend status and API key; events with `emailed_at` NULL; company `alert_email` settings |
| `cleanup` | `more: true` every night | Raise the budget or batch size in `packages/shared` (a release); check for missing indexes after a migration |
| `cleanup` | Screenshot rows not shrinking | Storage deletes failing: rows are kept on purpose until the object is gone |
| `cleanup` | Partition errors | Next month's partitions missing means inserts will fail on the 1st: run cleanup by hand now |

Running a job by hand:

```bash
curl -fsS -X POST https://<api host>/cron/cleanup -H "X-Cron-Secret: $CRON_SECRET"
```

Never paste the secret into a ticket or chat; read it from the secret store into the variable.

## Setting up with pg_cron and pg_net (default)

Schedule definitions belong in `db/cron/` (`cron-routes` task 2.4, not yet written). The secret
lives in Supabase Vault, never in the job text.

```sql
-- once per project, as postgres
SELECT vault.create_secret('<the CRON_SECRET value>', 'cron_secret');

SELECT cron.schedule('wb-heartbeat-check', '*/5 * * * *', $$
  SELECT net.http_post(
    url     := 'https://<api host>/cron/heartbeat-check',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'X-Cron-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets
                                   WHERE name = 'cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000);
$$);
```

Repeat for each row of the table above with its name and schedule (`wb-domain-verify`,
`wb-token-expiry`, `wb-alert-digest`, `wb-cleanup`). pg_cron runs in UTC.

| Check | Query |
|---|---|
| Jobs defined | `SELECT jobname, schedule, active FROM cron.job;` |
| Last runs | `SELECT jobid, status, start_time FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;` |
| HTTP answers | `SELECT status_code, created FROM net._http_response ORDER BY created DESC LIMIT 20;` |

pg_net is fire-and-forget: `cron.job_run_details` shows `succeeded` once the request is queued,
not when the API answered. Read `net._http_response` (or the API's log line) for the result.
`cleanup` can outlast the HTTP timeout; that is fine, the API keeps working and the lock
prevents a second run.

## Setting up with Cloud Scheduler

When the API runs on Cloud Run and pg_cron is not wanted:

```bash
gcloud scheduler jobs create http wb-cleanup \
  --schedule="0 2 * * *" --time-zone="Etc/UTC" \
  --uri="https://<api host>/cron/cleanup" --http-method=POST \
  --headers="X-Cron-Secret=${CRON_SECRET},Content-Type=application/json" \
  --attempt-deadline=30m
```

The header value is stored in the job definition, so restrict who can view scheduler jobs. Use one
scheduler, never both: two schedulers are harmless (the lock skips the second) but make failures
hard to read.
