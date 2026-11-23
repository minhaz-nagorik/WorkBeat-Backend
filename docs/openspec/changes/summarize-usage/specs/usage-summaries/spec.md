## Purpose

Per-day summaries of activity, built once a company day has ended, so reports do not add up
every raw row on each request. Reports give the same numbers with or without them.

## ADDED Requirements

### Requirement: Each finished company day is summarized
<!-- source: product owner 19 Nov 2026 · B19 · B15 -->
`POST /cron/usage-summary`, run hourly, SHALL build the summary of every retained day that has ended in the company's timezone and has none: per employee and hour, tracked seconds, sessions, activity samples, idle seconds and first and last activity; per employee and day, seconds per app name and per domain. A day with no activity MUST be marked as built. Today MUST NOT be summarized.

#### Scenario: A company ahead of UTC
- **WHEN** the job runs at 18:30 UTC for a company in `Asia/Dhaka`
- **THEN** the Dhaka day that ended 30 minutes earlier is summarized and the new day is not

#### Scenario: A backlog larger than one run
- **WHEN** a run's time budget is spent before every day is built
- **THEN** it answers `more` = `true` and the next run continues with the days not built

#### Scenario: Run twice
- **WHEN** the job runs again with nothing new to build
- **THEN** no summary row changes and `rows_affected` is empty

### Requirement: Reports give the same numbers from summaries
<!-- source: report-usage `usage-reports` · `calendar-and-timesheets` · `dashboard-summary` · `data-export` -->
Reports, the calendar, the timesheet, the dashboard and `daily-summaries.csv` SHALL read summaries for summarized days and raw rows for the other days of the range, and MUST return the same response either way. Categories MUST be applied when the report is read. `app-sessions.csv` and `url-visits.csv` MUST read raw rows.

#### Scenario: Before and after the job
- **WHEN** an admin reads the productivity report for last week, the job summarizes those days, and the admin reads it again
- **THEN** both responses are identical

#### Scenario: A rule added later
- **WHEN** an admin marks an app productive after its days were summarized
- **THEN** the next report counts that app's time on those days as productive

#### Scenario: Today in a range
- **WHEN** a report covers the last 7 days
- **THEN** the six finished days come from summaries and today from raw rows

### Requirement: A late batch updates its day at once
<!-- source: B7 · D13 · ingest-activity `activity-ingestion` -->
When `POST /v1/agents/activity` stores rows on a summarized day, it SHALL rebuild that employee's summary of the day in the same transaction. The job and ingest MUST take the same lock for a company day, so a batch stored while the day is being built is not lost. A batch that waits over 5 s for it MUST get `500 INTERNAL` and store nothing; otherwise the response MUST NOT change.

#### Scenario: A laptop offline for three days
- **WHEN** a batch with rows from three days ago arrives after that day was summarized
- **THEN** the next report includes those rows

#### Scenario: A batch during a build
- **WHEN** a late batch for a day arrives while the job is building that day
- **THEN** after both commit, the summary includes the batch's rows

#### Scenario: A build holds the day for a minute
- **WHEN** a late batch waits over 5 s for the day's lock
- **THEN** the response is `500 INTERNAL`, no row of the batch is stored, and the same batch sent again after the build is accepted

### Requirement: A timezone change rebuilds the summaries
<!-- source: B19 -->
A change of the company `timezone` SHALL delete the company's `usage_days` rows in the same transaction, so no day counts as built. Until the job builds them again, reports MUST read raw rows for those days and MUST NOT read the old summary rows.

#### Scenario: Dhaka to London
- **WHEN** an admin changes the timezone from `Asia/Dhaka` to `Europe/London`
- **THEN** the next report counts days from London midnight to London midnight

### Requirement: Summaries are tenant data and follow retention
<!-- source: B2 · B13 · D41 -->
Summaries SHALL have the same row-level security as activity rows, and no `staff` route MUST read them. Each run of the job MUST first delete each company's summaries of days before its first retained day.

#### Scenario: Retention lowered to 30 days
- **WHEN** a company changes retention from 90 to 30 days
- **THEN** the next run deletes its summaries older than 30 days

#### Scenario: Another company's summaries
- **WHEN** a company admin's report runs
- **THEN** it reads no summary row of another company
