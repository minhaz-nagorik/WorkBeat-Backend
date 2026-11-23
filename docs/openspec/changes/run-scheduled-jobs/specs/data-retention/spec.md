## Purpose

What the nightly `/cron/cleanup` creates and deletes: future partitions, each company's activity
and screenshots past its retention, old idempotency rows, and partitions past the 90-day maximum.

## ADDED Requirements

### Requirement: Cleanup prepares partitions first
<!-- source: Plan-v3.5 §6.3 · data-model.md §6 · B13 -->
Each `/cron/cleanup` run SHALL first call `cron_ensure_month_partitions()`, so partitions exist from last month to two months ahead, before it deletes anything. Calling it twice MUST create nothing new.

#### Scenario: A new month approaches
- **WHEN** cleanup runs on 15 November
- **THEN** partitions for October to January exist on all four partitioned tables

#### Scenario: The year turns
- **WHEN** cleanup runs on 20 December 2026
- **THEN** partitions for November 2026 to February 2027 exist

#### Scenario: A partition already exists
- **WHEN** next month's partition was created by an earlier run
- **THEN** the run creates nothing for it and does not fail

### Requirement: Activity past a company's retention is deleted
<!-- source: B13 · PRD "Retention and suspension" · Plan-v3.5 §4.4 "Reports and data lifecycle" -->
For each company, cleanup SHALL delete `app_sessions`, `url_visits`, `activity_buckets` and `idle_intervals` rows whose time column is before now minus `data_retention_days`, in batches of at most one company day of one table, each batch its own transaction in `system` scope, until none remain or the run's time budget is spent. A spent budget MUST return `more` = `true`.

#### Scenario: A company keeps 30 days
- **WHEN** cleanup runs for a company with `data_retention_days` = 30
- **THEN** its rows older than 30 days are gone and its newer rows and other companies' rows are untouched

#### Scenario: A released device
- **WHEN** a device was released 10 days ago in a company keeping 90 days
- **THEN** its rows stay until each passes 90 days, like any other device's

#### Scenario: Retention lowered from 90 to 30 days
- **WHEN** a company with 90 days of data lowers `data_retention_days` to 30 and the backlog exceeds one run's budget
- **THEN** the run deletes oldest first, returns `more` = `true`, and later runs finish the backlog

#### Scenario: Retention raised from 30 to 90 days
- **WHEN** a company raises `data_retention_days` from 30 to 90
- **THEN** cleanup deletes nothing newer than 90 days and already deleted rows stay deleted

#### Scenario: A row exactly at the boundary
- **WHEN** a row's time equals the run's start time minus `data_retention_days`
- **THEN** the row is kept

#### Scenario: A row a minute either side of the cut-off
- **WHEN** a company keeps 30 days and has rows 30 days and one minute old and 30 days less one minute old
- **THEN** the older row is deleted and the newer row is kept

#### Scenario: A suspended or expired company
- **WHEN** a company is `suspended` or `expired`
- **THEN** its rows are deleted by its retention exactly as for an `active` company

### Requirement: Screenshots past retention are deleted with their files
<!-- source: B13 · PRD "Retention and suspension" · PRD "Screenshots" -->
Cleanup SHALL delete each stored object (B26) at `screenshots.storage_path` whose `captured_at` is before now minus the company's `data_retention_days`, with its thumbnail object (`.thumb.jpg`) when it has one, then delete those `screenshots` rows. A row whose object could not be deleted MUST be kept for the next run; a missing object MUST count as deleted.

#### Scenario: Storage fails for one object
- **WHEN** Storage refuses one of a batch of 100 deletes
- **THEN** 99 rows are deleted and that one row remains for the next run

#### Scenario: Storage is down for the whole run
- **WHEN** every Storage delete fails
- **THEN** no `screenshots` row is deleted and the activity tables are still cleaned

#### Scenario: The object was already gone
- **WHEN** an expired screenshot's object no longer exists in Storage
- **THEN** its row is deleted and counted

### Requirement: Short-lived and resolved records are deleted
<!-- source: D13 · D7 · data-model.md "ingest_batches", "tamper_events" -->
Cleanup SHALL delete `ingest_batches` rows with `received_at` older than 14 days, and `tamper_events` rows with `occurred_at` before now minus the company's `data_retention_days` that are resolved. An unresolved tamper event MUST be kept, because device status depends on it.

#### Scenario: An open tamper event is old
- **WHEN** a tamper event with `resolved_at` NULL is older than retention
- **THEN** it is kept and the device still shows `tamper`

#### Scenario: An ingest batch exactly 14 days old
- **WHEN** an `ingest_batches` row's `received_at` equals the run's start minus 14 days
- **THEN** it is kept until the next run

#### Scenario: A resolved clock event past retention
- **WHEN** a `clock_tampered` event resolved long ago is older than the company's retention
- **THEN** it is deleted like any resolved tamper event

### Requirement: Screenshots never confirmed are deleted after a day
<!-- source: B7 · D23 · ingest-activity/screenshot-upload -->
Cleanup SHALL delete every `screenshots` row still `pending` 24 hours after its `created_at`, together with any object at its `storage_path` and its thumbnail path, whatever the company's retention.

#### Scenario: An upload URL was requested but nothing was uploaded
- **WHEN** a screenshot row has been `pending` for 25 hours
- **THEN** the next cleanup deletes the row
- **AND** it never appears in a timeline

#### Scenario: A confirm arrives just in time
- **WHEN** a screenshot is confirmed 23 hours after its request
- **THEN** cleanup keeps it as an `uploaded` screenshot under normal retention

### Requirement: Legal evidence and directory data are never deleted
<!-- source: D25 · data-model.md "notice_acknowledgements" -->
Cleanup MUST NOT delete `notice_acknowledgements`, `employees`, `devices`, `users`, `companies`, `licenses` or any rule or settings row, whatever their age.

#### Scenario: A two-year-old acknowledgement
- **WHEN** cleanup runs and an acknowledgement is older than 365 days
- **THEN** the row remains

### Requirement: Partitions past the maximum are dropped
<!-- source: B13 · Plan-v3.5 §4.4 "Reports and data lifecycle" -->
After the per-company deletes, cleanup SHALL call `cron_drop_old_partitions(90)`, dropping every monthly partition that ends more than 90 days ago, and MUST report the number dropped.

#### Scenario: A partition ends 120 days ago
- **WHEN** cleanup runs
- **THEN** that partition is dropped and counted in `rows_affected`

#### Scenario: A partition partly inside the window
- **WHEN** a monthly partition ends 85 days ago and began 115 days ago
- **THEN** it is kept

#### Scenario: Nothing to drop
- **WHEN** no partition ends more than 90 days ago
- **THEN** the run reports 0 partitions dropped

### Requirement: An interrupted cleanup loses nothing and resumes
<!-- source: B15 · Plan-v3.5 §6.4 · design.md -->
When a cleanup run stops part-way (a crash, a timeout or a lost connection), every batch already committed SHALL stay deleted and the next run MUST continue from what remains, deleting no row twice and never leaving a Storage object without its row being deleted later. A run that overlaps another between batches MUST only delete rows the other has not.

#### Scenario: The process is killed after 40 batches
- **WHEN** a cleanup run is killed after committing 40 batches
- **THEN** those 40 batches stay deleted and the next run deletes the rest

#### Scenario: Killed between a Storage delete and the row delete
- **WHEN** a run deletes a batch of objects and is killed before deleting their rows
- **THEN** the next run counts the missing objects as deleted and deletes their rows
