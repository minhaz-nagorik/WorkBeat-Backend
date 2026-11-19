## Context

Reports, the calendar, the timesheet, the dashboard and the daily CSV add up `app_sessions`,
`url_visits`, `activity_buckets` and `idle_intervals` for the range on every request. Days are
company-timezone days (B19). Ranges are at most 90 days and retention is 30, 60 or 90 (B13).

## Decisions

### A company day is either summarized or raw, never both
`usage_days (company_id, day)` marks a company day whose summary is built. A report splits its
range: marked days read `usage_hours`, `usage_apps` and `usage_domains`; the other days read raw
rows. The raw query covers only the span from the first to the last unmarked day, so it
normally reads only today. The marker and the summary rows are written in one transaction, so a
report never sees half a day.

### The summary keeps names, not categories
`usage_apps` keeps seconds per exact app name and `usage_domains` per domain. Categories are
looked up once per distinct name when a report is read, so a productivity rule change applies to
every past day, as it does today (concern #8). Grouping by name before looking up the category
gives the same split, because the category depends only on the name.

### Hours keep what the activity report needs
`usage_hours` is per employee, day and hour of the event's start: tracked seconds, session count,
bucket count, active and total samples, idle seconds (numeric, so the total rounds once as
before) and the first start and last end of the sessions that started in that hour. Days are
sums of hours; the hourly average divides by the days that had a session in that hour, as before.
The session and bucket counts keep a day with only idle time out of the daily rows, as before.

### Built hourly, per company day, within a time budget
The job runs hourly so each company's day is built soon after its local midnight. Each company
day is one short transaction under the job lock (B15 pattern). A run stops at the budget in
`contract.ts` and answers `more: true`; the first runs after deploy backfill up to 90 days per
company over several hours, newest day first. Reports are correct throughout because unmarked
days read raw rows.

### Late batches rebuild one employee-day under a per-day lock
The ingest window is 8 days (B7), so finished days receive late rows. After inserting, ingest
finds the batch's company days before today, takes `pg_advisory_xact_lock('usage', company+day)`
for each in date order, and rebuilds that employee's rows for days already marked. The job takes
the same lock before building a day. Whichever transaction gets the lock second sees the other's
committed rows, so no late row is lost: ingest waits for a build in progress and then rebuilds,
or the build waits for the ingest and then reads its rows.

### A timezone change deletes the company's summaries
Days and hours depend on the timezone. `PATCH /v1/company/settings` with a new timezone deletes
the company's markers and summary rows in its transaction; reports read raw rows until the job
builds them again. Builders read the timezone with `FOR SHARE`, so a build cannot commit
summaries in the old timezone after the change.

### Summaries follow retention in the same job
Summaries hold app names and domains per employee, so they are personal data like the raw rows.
The job deletes each company's summaries and markers older than its first retained day before
building. `/cron/cleanup` does not need to know about them.

## Risks / Trade-offs

- An ingest of a late batch can wait about a second while the job builds the same company day.
- A day the job has not reached yet is as slow as before; only the first hours after deploy and
  after a timezone change are affected.
- The 8–20 s and sub-second figures are estimates until the 100-employee data set is measured
  (task 4.3).
