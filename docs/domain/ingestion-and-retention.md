# Ingestion and retention

How activity batches and screenshots are written exactly once, which records are kept, and how
each company's data is deleted when its retention ends. The agent's view is each agent
repository's `docs/domain/activity-model.md`. Requirements:
[`activity-ingestion`](../openspec/changes/ingest-activity/specs/activity-ingestion/spec.md),
[`screenshot-upload`](../openspec/changes/ingest-activity/specs/screenshot-upload/spec.md),
[`screenshot-access`](../openspec/changes/ingest-activity/specs/screenshot-access/spec.md),
[`data-retention`](../openspec/changes/run-scheduled-jobs/specs/data-retention/spec.md),
[`cron-routes`](../openspec/changes/run-scheduled-jobs/specs/cron-routes/spec.md).

## Activity batches

`POST /v1/agents/activity` carries one sealed batch: `app_sessions[]`, `url_visits[]`,
`activity_buckets[]`, `idle_intervals[]`. Any array may be empty (a feature switched off, D37).
This route and the two screenshot routes also accept a released device's key for 7 days after
`released_at`, so the agent can upload what it held at release (D45, B21).

### Idempotency (D13)

| Case | Answer | Writes |
|---|---|---|
| New `batch_id` for this device | `200` with counts per array and `dropped_out_of_window` | `ingest_batches` row (with `body_sha256`) and every kept record, one transaction |
| Same `batch_id`, same body hash | `200` with the first answer's counts | Nothing |
| Same `batch_id`, different body hash | `409 IDEMPOTENCY_KEY_REUSED` | Nothing |
| Two copies at once | Both get the same counts | Records stored once |
| `Idempotency-Key` ≠ `batch_id` | `400 VALIDATION_FAILED` | Nothing |
| A record fails its schema | `400` / `422 VALIDATION_FAILED` | Nothing from the batch |

The agent quarantines a batch on `400`, `409`, `413` and `422` and retries the rest. An activity
bucket already stored for `(device_id, bucket_start)` has its samples replaced.

### Time window (B7)

A record whose `started_at`, `visited_at` or `bucket_start` is before server now − 8 days or after
server now + 1 day is dropped and counted. The rest of the batch is stored with `200`. Example:
10 sessions, 2 dated 6 days ahead → 8 stored, `dropped_out_of_window` 2.

| Record | Window applies? |
|---|---|
| Activity rows | Dropped and counted |
| Screenshot request | Refused whole, `422` (one record; nothing else to save) |
| Tamper event | Never (D24); a future time is clamped to now |

### Stamping and storage

- `company_id`, `device_id` and `employee_id` come from the binding of the device key that
  uploaded the record, never the body. A binding's employee never changes, and nothing is
  re-credited by time (D48). A released key uploading in its 7-day window stores under the
  released binding (D45). Reports never join through `devices`.
- Wire `session_user` is stored as `os_user`; Unix ms become `timestamptz`.
- Records are stored as sent. The agent filters sensitive domains and switched-off features; the
  API adds nothing. An empty `window_title` is valid.

### Partitions

`app_sessions`, `url_visits`, `activity_buckets` and `idle_intervals` are range-partitioned by
month on their time column. `ensure_month_partitions` keeps last month to two months ahead, which
covers the whole B7 window, so there is no default partition. Partitions have no FKs and no
grant to `workbeat_api` (read through the parent only).

## Screenshots

| Step | Route | Result |
|---|---|---|
| 1. Request | `POST /v1/agents/screenshots` with `id`, `captured_at`, `bytes`; `Idempotency-Key` = `id` | `pending` row; `201` with a short-lived signed `upload_url` |
| 2. Upload | `PUT` the JPEG to `upload_url` | Object in the private `screenshots` bucket |
| 3. Confirm | `POST /v1/agents/screenshots/:id/confirm` | `uploaded` only if the object exists with size = `bytes` |

| Case | Answer |
|---|---|
| Repeat request, still `pending` | `200` with a fresh `upload_url` |
| Repeat request, `uploaded` | `200`, `upload_url` null |
| Known `id` with other `captured_at` / `bytes`, or another device | `409 IDEMPOTENCY_KEY_REUSED` |
| `bytes` over the limit, or outside the window | `422`, nothing written |
| Confirm, object missing or wrong size | `422`, row stays `pending`; a wrong-size object is deleted |
| Confirm, unknown `id` | `404 NOT_FOUND` |
| Screenshots switched off since capture | Accepted: the agent's policy can be 30 minutes old |

**Storage path:** `{company_id}/{device_id}/{id}.jpg`, unique. The id, not a timestamp, because it
is the idempotency key. Paths and signed URLs are never logged.

**Viewing:** `GET /v1/employees/:id/screenshots?date=` returns that day (company `timezone`) of
`uploaded` screenshots, oldest first, each with a 5-minute signed `view_url`. `company_admin` and
the employee's manager only; `it_admin` and staff `403`; outside the team `404`. While the tier is
`off`: `screenshots_enabled` false, no items, no URL issued.

## Retention (B13)

Each company keeps activity for `data_retention_days`, 1–365, default 90. Changing it deletes
nothing at once; the next cleanup does.

### `/cron/cleanup` (B15)

Daily at 02:00 UTC, `system` scope, behind `X-Cron-Secret`.

| Order | Step |
|---|---|
| 1 | `cron_ensure_month_partitions()`: create upcoming partitions |
| 2 | Per company: delete activity rows older than its retention, in batches |
| 3 | Per company: delete expired screenshot objects, then their rows |
| 4 | Delete `ingest_batches` older than 14 days; resolved `tamper_events` older than retention |
| 5 | `cron_drop_old_partitions(365)`: drop months that end more than 365 days ago |

- Each batch is its own short transaction that sets `system` scope and takes the job's
  `pg_try_advisory_xact_lock`; if held, the run answers `skipped`.
- A run stops at its time budget and answers `more: true`; the next run continues. Deletes are
  idempotent, so a cut-short run loses nothing.
- Storage first: a row whose object delete failed is kept for the next run; a missing object
  counts as deleted.
- Released devices' rows age out like any other device's.

### Never deleted

`notice_acknowledgements`, `employees`, `devices`, `users`, `companies`, `licenses`, every rule
and settings row, and unresolved tamper events (device status depends on them). Used enrollment
tokens are kept because devices reference them; `/cron/token-expiry` deletes only unused, expired
ones.

## Gaps found

- **Unlisted tables.** Cleanup says nothing about `monitoring_pauses`, `stripe_events`,
  `invitations` or used `enrollment_tokens`. They are not deleted today, but are not on the
  "never deleted" list either.
- **Screenshot window.** [ingest-activity design.md](../openspec/changes/ingest-activity/design.md)
  amends B7 for screenshots (refuse, not drop); B7 itself was not updated to say so.
- **`ingest_batches` keep 14 days** is in the spec and a schema comment, not in a B-number.
