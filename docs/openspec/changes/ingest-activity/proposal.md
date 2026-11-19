## Why

Every report, timesheet and screenshot timeline is built from what the agents upload every 10
minutes. An upload is retried until a 2xx arrives, so each batch must be written once however often
it is sent (D13); a batch may have empty arrays for features switched off (D37); records from a
skewed clock are dropped and counted, never a reason to refuse the batch (B7). Screenshots go
straight to private storage through signed URLs and are shown only to the admin and the employee's
manager (D23, PRD "Screenshots", PRD "Permission matrix").

## What Changes

- **`POST /v1/agents/activity`** writes one sealed batch of app sessions, URL visits, activity buckets
  and idle intervals in one transaction, idempotent on `batch_id`; a repeat returns the first
  result; the same key with a different body gets `409 IDEMPOTENCY_KEY_REUSED`.
- **Records are stamped** with the device's company, device and current employee; times outside
  [now − 8 days, now + 1 day] are dropped and counted as `dropped_out_of_window` (B7).
- **`POST /v1/agents/screenshots`** records a pending screenshot and returns a short-lived signed
  upload URL to `{company_id}/{device_id}/{id}.jpg`; **`POST /v1/agents/screenshots/:id/confirm`**
  checks the object and marks it uploaded.
- **`GET /v1/employees/:id/screenshots`** returns a day's timeline with 5-minute signed view URLs for
  the company admin and the employee's manager, hidden while the company's tier is off.

## Capabilities

### New Capabilities

- `activity-ingestion`: the batch route, its idempotency, validation, stamping and time window.
- `screenshot-upload`: the upload request, the signed URL, the confirmation and their repeats,
  and an optional thumbnail for timeline tiles (19 Nov 2026).
- `screenshot-access`: who sees which screenshots, for how long a view URL lives, and optional hours of
  each day in a range (19 Nov 2026).

### Modified Capabilities

None.

## Impact

- Consumed by both agents: `buffer-and-sync` (`activity-sync`: sealed batches, quarantine on
  `400`/`409`/`413`/`422`) and `capture-screenshots` (`screenshot-capture`: signed upload, confirm).
- Depends on `enroll-devices` (`device-authentication`: `401` and `402` on every agent route).
  `report-usage` reads the rows written here; `run-scheduled-jobs` (`data-retention`) deletes them.
- Schema: `ingest_batches`, `app_sessions`, `url_visits`, `activity_buckets`, `idle_intervals`,
  `screenshots`. One migration adds `ingest_batches.body_sha256` (see `tasks.md`).
- Storage: private bucket `screenshots`, JPEG only, size limit from `packages/shared`.
