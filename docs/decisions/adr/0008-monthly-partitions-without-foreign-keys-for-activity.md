# ADR 0008 — Monthly partitions without foreign keys for activity

**Status:** Accepted
**Date:** 2026-11-15

## Context

`app_sessions`, `url_visits`, `activity_buckets` and `idle_intervals` take every device's batch
every 10 minutes; at 100,000 employees that is most of the roughly 555 requests per second in
Plan-v3.5 §6.3. Retention is per company, 30, 60 or 90 days (B13), so old rows must go every night,
and partitions cannot be dropped per company. Agents retry a batch until a 2xx, so the same batch
arrives more than once (D13), and an agent's clock can be wrong.

## Decision

The four tables are range-partitioned by month on their time column (Plan §6.3). Each row carries
`company_id`, `device_id` and the device's `employee_id` at ingest, so reports never join through
`devices`. They have no surrogate key and no foreign keys; integrity comes from the device guard,
which stamps the IDs from the credential, and from `ingest_batches`. Idempotency lives in
`ingest_batches` (PK `device_id`, `batch_id`) with `counts` and `body_sha256`: a repeat with the
same body returns the stored counts, and the same key with a different body gets
`409 IDEMPOTENCY_KEY_REUSED`. A batch's rows and its `ingest_batches` row are written in one
transaction. Records outside [server now − 8 days, server now + 1 day] are dropped and counted in
`dropped_out_of_window`; the batch is still accepted (B7). Partitions exist from last month to two
months ahead (`cron_ensure_month_partitions()`), so no default partition is needed. Nightly
`/cron/cleanup` deletes each company's rows past its retention in batches (B15) and drops whole
partitions past 365 days (`cron_drop_old_partitions()`). `ingest_batches` rows are kept 14 days.

**Note (19 Nov 2026):** retention is now at most 90 days (B13, migration 0009), so cleanup calls
`cron_drop_old_partitions(90)`; the 365 days below are from before that change.

## Consequences

Inserts stay cheap; a 365-day drop is a `DROP TABLE`, not a delete. The time window keeps every
record inside an existing partition. The cost: a bug in the guard could store a row with a wrong
device or employee and nothing in the schema would refuse it; rows cannot be addressed one by one,
so corrections are by time range; per-company retention under 90 days is still row deletes; and
an agent offline more than 8 days loses those records (it keeps at most 7, D7).

## Alternatives considered

| Option | Why not |
|---|---|
| Foreign keys to `devices` and `employees` | A lookup per row on the hottest path; partitioned FKs add cost a load test has not justified (shortcut noted in 0001_init.sql) |
| One table per company | Thousands of tables; migrations and grants multiply |
| No partitions, delete by time | Nightly deletes of millions of rows, bloat, and no cheap drop past 365 days |
| Idempotency by a unique key on each row | Needs a surrogate key on every row, and cannot tell a reused key with a different body |
| Refuse a whole batch for one bad timestamp | One skewed clock would quarantine good data (B7) |

## Links

- Decisions: [B7, B13, B15](../backend-decisions.md), D7, D13, Plan-v3.5 §6.3.
- Designs: [ingest-activity](../../openspec/changes/ingest-activity/design.md) (screenshots outside
  the window are refused), [process-tamper-alerts](../../openspec/changes/process-tamper-alerts/design.md)
  (tamper events are exempt from B7).
- Specs: [activity-ingestion](../../openspec/changes/ingest-activity/specs/activity-ingestion/spec.md),
  [data-retention](../../openspec/changes/run-scheduled-jobs/specs/data-retention/spec.md),
  [usage-reports](../../openspec/changes/report-usage/specs/usage-reports/spec.md).
