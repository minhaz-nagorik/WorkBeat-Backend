## Why

Reports are what a company pays for: app and website usage, activity level, productivity split,
calendar, weekly timesheet and CSV export (Plan-v3.5 §4.4 "Reports and data lifecycle"). Tracked
time is all foreground time with activity percent beside it (D1), productivity is resolved when a
report is read (PRD "Activity levels, productivity, calendar and timesheets"), managers see only
their own team (B12) and staff never see any of it (D41).

## What Changes

- **Usage reports** over a date range for one employee, a manager's team, a department or the
  company: top apps, top websites, activity by hour and productivity split.
- **Calendar** (day, week, month per employee) and the **weekly timesheet** as JSON and PDF.
- **CSV export** of app sessions, URL visits and daily summaries, with a row cap.
- **Dashboard summary**: device counts, today's activity, recent alerts and seats.
- **Company time zone**: a new `companies.timezone` column (IANA, default `UTC`) fixes day and week
  boundaries; the schema had none.
- Every route is read-only, runs in `tenant` scope (B2) and computes on read; no rollup tables.

## Capabilities

### New Capabilities

- `usage-reports`: range and scope rules, role access, app, website, activity and productivity reports.
- `calendar-and-timesheets`: per-employee calendar and the Monday-start weekly timesheet and its PDF.
- `data-export`: CSV exports, their columns, row cap and spreadsheet-formula guard.
- `dashboard-summary`: the dashboard's device counts, today's activity, alerts and seats.

### Modified Capabilities

None.

## Impact

- Consumed by the web platform (WorkBeat Admin) report, calendar, timesheet and dashboard pages.
- Reads rows written by `ingest-activity` and rules from `serve-agent-policy` (`productivity-rules`);
  device status comes from `receive-device-health` (`device-status`), alerts from
  `process-tamper-alerts` (`alerts-feed`), roles from `authenticate-users` (`role-access`),
  teams from `manage-employees` (`manager-teams`).
- Schema: migration `0002` adds `companies.timezone`; editing it belongs to `configure-company`.
- `packages/shared`: report query and response schemas, browser app list, export row cap.
