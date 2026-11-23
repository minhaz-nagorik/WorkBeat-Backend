> **Read first — this task list is not the requirement.**
> Capabilities: `usage-reports · calendar-and-timesheets · data-export · dashboard-summary`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show report-usage`.
> Contract: [agent-contract.md](../../../core/api/agent-contract.md) · Schema: [data-model.md](../../../core/architecture/data-model.md).

## 1. Schema and shared contract

- [x] 1.1 `db/migrations/0002_spec_gaps.sql` `db/migrations/0002_company_timezone.sql`: `companies.timezone text NOT NULL DEFAULT 'UTC'` with a CHECK that it is a known `pg_timezone_names` name; self-check in `db/tests/`
- [ ] 1.2 `packages/shared`: report query schema (`from`, `to`, one of `employee_id` / `manager_user_id` / `department`, `limit`), response schemas, browser app list, export row cap, 90-day span limit
- [ ] 1.3 Codes `FORBIDDEN` (if `authenticate-users` has not added it) and `EXPORT_TOO_LARGE` in the catalog

## 2. usage-reports

- [ ] 2.1 Scope resolver: role check (`role-access`), manager team intersection (B12), employee/department/team filter, tenant scope (B2)
- [ ] 2.2 Range parser: local dates in `companies.timezone` → UTC bounds; clamp to `data_retention_days`; return effective range
- [ ] 2.3 Raw SQL per report with a bounded time predicate on the partition key, hitting `(company_id, employee_id, <time>)`
- [ ] 2.4 Productivity join on `lower(app_name)` / `lower(domain)` against `productivity_rules`; browser sessions out of the split
- [ ] 2.5 Tests: it_admin and super_admin → 403; manager outside team → 404; tenant isolation with two companies; rule edit re-categorises history; idle not subtracted; browser hour counted once; reversed range → 422; clamp to retention
- [ ] 2.6 Load test: one employee, one week, every report < 1 s on the 5,000-device data set
- [ ] 2.7 Clamp `to` to today in `companies.timezone`; tie-break ranking by name; domain rule match on equality or `.`-suffix, longest pattern wins
- [ ] 2.8 Tests (edge cases): manager with no team → zeros; archived employee report → 200; two scope params → 422; empty department → zeros; 90 days ok, 91 → 422; range across the Oct/Nov partition boundary counts each row once; range wholly before retention → zeros with effective range; future `to` clamped; `Europe/London` fall-back day = 25 h, no row lost or doubled; case-insensitive app rule; `limit` 0 / 101 → 422; tie order stable; no samples → `activity_percent` null; subdomain match, longest pattern wins, look-alike domain neutral

## 3. calendar-and-timesheets

- [ ] 3.1 `GET /v1/employees/:id/calendar` (day / week / month) with `paused` from `monitoring_pauses`
- [ ] 3.2 `GET /v1/employees/:id/timesheet` and `/timesheet.pdf` (PDF built in memory, never stored)
- [ ] 3.3 Tests: Asia/Dhaka day boundary; non-Monday week → 422; manager on another team's employee → 404; another company's employee → 404; PDF content type and file name
- [ ] 3.4 Tests (edge cases): `America/New_York` spring-forward day = 23 h; session over midnight on its start day; week across a month end; partly paused day; cancelled pause not `paused`; timesheet week across DST has 7 rows; empty day → `null` first/last; unsafe characters stripped from the PDF file name; it_admin PDF → 403 before building

## 4. data-export

- [ ] 4.1 Three CSV routes reading at most cap + 1 rows; over the cap → 422 `EXPORT_TOO_LARGE`
- [ ] 4.2 CSV writer with formula guard and quoting
- [ ] 4.3 Tests: formula guard; cap exceeded writes no partial file; manager export holds only own team; tenant isolation; no URL or title in logs
- [ ] 4.4 Tests (edge cases): offsets switch across DST inside one file; empty export → header only; manager `employee_id` outside the team → 404; exactly the cap → full file, cap + 1 → 422; UTF-8 non-Latin titles

## 5. dashboard-summary

- [ ] 5.1 `GET /v1/dashboard` composing device counts (`device-status`), today's activity, newest five from `alerts-feed`, seats
- [ ] 5.2 Tests: section presence per role; manager counts only team devices; released devices not counted; super_admin → 403; tenant isolation
- [ ] 5.3 Tests (edge cases): offline + tampered device counted once; no devices → zeros; `today` just after local midnight; seats used above the limit shown as is
