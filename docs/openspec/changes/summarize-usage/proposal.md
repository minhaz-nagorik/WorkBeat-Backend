## Why

Every report adds up the raw activity rows on each request. At 100 employees a 90-day report
reads about 3.8 million rows, which is estimated at 8–20 seconds (WorkBeat-Concerns #12; not yet
measured). A finished day never changes except when a late batch arrives, so its totals can be
added up once and kept (product owner, 19 Nov 2026: option 2).

## What Changes

- **Per-day summaries** for every finished company day: per employee and hour (tracked time,
  sessions, activity samples, idle time, first and last activity) and per employee and day
  (seconds per app and per website).
- **`POST /cron/usage-summary`**, hourly: builds the summaries of days that have ended in the
  company's timezone, oldest work first within a time budget, and deletes summaries past
  retention. Also builds the cron route mechanism (`run-scheduled-jobs` tasks 2.1, 2.2).
- **Reports read summaries for summarized days and raw rows for the rest** (today, and any day
  not built yet). Productivity categories are still applied when a report is read, so a rule
  change applies to past days at once. Every number in every response stays the same.
- **A late batch** for a summarized day rebuilds that employee's day in the ingest transaction.
- **A timezone change** deletes the company's summaries; they are built again by the job.

## Capabilities

### New Capabilities

- `usage-summaries`: what is summarized, when, how reports combine summaries with raw rows,
  late batches, timezone changes and retention.

### Modified Capabilities

None. `run-scheduled-jobs` (`cron-routes`) gains the job in its job list.

## Impact

- Schema: `0010_usage_summaries.sql` adds `usage_days`, `usage_hours`, `usage_apps` and
  `usage_domains`, with tenant row-level security.
- API: report, calendar, timesheet, dashboard and `daily-summaries.csv` read the summaries; the
  raw CSV exports (`app-sessions.csv`, `url-visits.csv`) do not change. No response changes.
- Agents: `POST /v1/agents/activity` keeps its contract; a batch with rows on a past day takes
  a per-day lock and may rebuild one employee-day.
- Operations: the scheduler calls `/cron/usage-summary` hourly with `CRON_SECRET`.
