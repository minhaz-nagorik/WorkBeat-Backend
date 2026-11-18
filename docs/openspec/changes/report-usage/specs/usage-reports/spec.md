## Purpose

The usage reports a company admin or manager reads over a date range: top apps, top websites,
activity by hour and the productivity split, for one employee, a team, a department or the company.

## ADDED Requirements

### Requirement: Only company admins and managers read reports
<!-- source: D41 · B2 · B12 · PRD "Users and roles" -->
`GET /v1/reports/apps`, `/reports/websites`, `/reports/activity` and `/reports/productivity` SHALL run in `tenant` scope for `company_admin` (every employee) and `manager` (only employees whose `manager_user_id` is the caller). `it_admin` and `super_admin` MUST get `403 FORBIDDEN`, and staff scope MUST never read an activity table.

#### Scenario: An IT admin opens a report
- **WHEN** an `it_admin` calls `GET /v1/reports/apps`
- **THEN** the response is `403` with `code` `FORBIDDEN`
- **AND** no activity table is queried

#### Scenario: A manager asks for an employee outside the team
- **WHEN** a manager calls a report with `employee_id` of an employee managed by someone else
- **THEN** the response is `404` with `code` `NOT_FOUND`

#### Scenario: Two companies report in parallel
- **WHEN** admins of two companies read reports at the same time
- **THEN** each response holds only rows of the caller's company

#### Scenario: A manager with no team
- **WHEN** a manager with no assigned employee calls `GET /v1/reports/activity`
- **THEN** the response is `200` with zero totals

#### Scenario: An archived employee
- **WHEN** a company admin calls a report with `employee_id` of an archived employee
- **THEN** the response is `200` with that employee's retained history

### Requirement: Reports take one range and one scope
<!-- source: Plan-v3.5 §4.4 "Reports and data lifecycle" · B12 · PRD "Retention and suspension" -->
Every report SHALL take `from` and `to` dates (inclusive, in `companies.timezone`) and at most one of `employee_id`, `manager_user_id` or `department`; none means the caller's whole scope. A manager's scope MUST be intersected with the own team, and `manager_user_id` MUST be refused for a manager with `403 FORBIDDEN` unless it is the caller.

#### Scenario: A manager filters by department
- **WHEN** a manager calls a report with `department` = `Sales`
- **THEN** only Sales employees managed by that manager are counted

#### Scenario: An admin reads a team
- **WHEN** a company admin calls a report with `manager_user_id` of a manager
- **THEN** only employees whose `manager_user_id` is that manager are counted

#### Scenario: Two scope parameters
- **WHEN** a report is called with both `employee_id` and `department`
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

#### Scenario: A department with no employees
- **WHEN** a company admin calls a report with `department` `Nobody`
- **THEN** the response is `200` with zero totals

### Requirement: Totals leave out archived employees
<!-- source: WorkBeat Admin request (18 Nov 2026) -->
A report or export without `employee_id` SHALL count only employees whose `archived_at` is null, whether the scope is the caller's, a `manager_user_id` or a `department`. With `employee_id` an archived employee's retained history MUST still be returned.

#### Scenario: A company total after an archive
- **WHEN** an employee with 5 hours tracked this week is archived and an admin reads this week's productivity without a scope
- **THEN** the totals do not include those 5 hours

#### Scenario: A department with an archived member
- **WHEN** a company admin reads a report with `department` `Sales` and one Sales employee is archived
- **THEN** only the Sales employees who are not archived are counted

### Requirement: Ranges are validated and clamped to retention
<!-- source: B13 · PRD "Retention and suspension" · Plan-v3.5 §6.3 -->
A range with a malformed date, `to` before `from`, or more than 366 days SHALL get `422 VALIDATION_FAILED`. A `from` older than the company's `data_retention_days` MUST be moved to the first retained day, and every report MUST return the effective `from` and `to`. Periods with no rows, including paused periods, MUST count as zero.

#### Scenario: The range starts before retention
- **WHEN** a company keeping 7 days asks for the last 30 days
- **THEN** the report covers the last 7 days and returns that `from`

#### Scenario: The range is reversed
- **WHEN** `to` is before `from`
- **THEN** the response is `422` with `code` `VALIDATION_FAILED` naming `to`

#### Scenario: Exactly 366 days
- **WHEN** a range spans 366 days, and another 367 days
- **THEN** the first is served and the second gets `422 VALIDATION_FAILED`

#### Scenario: A range across a partition boundary
- **WHEN** a range runs from 25 October to 5 November
- **THEN** rows from both monthly partitions are counted, each once

#### Scenario: A range entirely before retention
- **WHEN** a company keeping 7 days asks for a range that ended 30 days ago
- **THEN** the response is `200` with zero totals and the effective `from` and `to`

#### Scenario: A range ending in the future
- **WHEN** `to` is next week
- **THEN** the effective `to` is today in `companies.timezone`

#### Scenario: A daylight-saving day
- **WHEN** a company in `Europe/London` reports on the day the clocks go back
- **THEN** that day covers 25 hours of rows and no row is counted twice or dropped

### Requirement: Productivity is resolved when the report is read
<!-- source: PRD "Activity levels, productivity, calendar and timesheets" · Plan-v3.5 §4.4 -->
The API SHALL categorise each `app_sessions` row by `app_name` against `productivity_rules` with `match_type` `app`, and each `url_visits` row by `domain` against `match_type` `domain`, case-insensitively, at read time. No match MUST mean `neutral`. A category MUST NOT be stored on an activity row, so an edited rule MUST change every later report, history included.

#### Scenario: A rule is edited
- **WHEN** an admin changes `slack` from `neutral` to `productive` and reloads last month's report
- **THEN** last month's Slack seconds count as productive

#### Scenario: A rule written in another case
- **WHEN** a rule for app `Slack` is `productive` and sessions carry `slack`
- **THEN** those sessions count as productive

### Requirement: App and website reports rank time
<!-- source: D1 · Plan-v3.5 §4.4 · prototype "Top apps", "Websites" -->
`GET /v1/reports/apps` SHALL return the scope's apps ranked by summed `app_sessions.duration_seconds`, each with `app_name`, `seconds` and `category`. `GET /v1/reports/websites` SHALL return domains ranked by summed `url_visits.duration_seconds`, each with `domain`, `seconds` and `category`. Both MUST accept `limit` (default 10, at most 100).

#### Scenario: Top five apps for a week
- **WHEN** an admin asks for `limit=5` over one week for one employee
- **THEN** five apps are returned, highest `seconds` first, each with its category

#### Scenario: limit out of range
- **WHEN** `limit` is 0 or 101
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

#### Scenario: Equal seconds
- **WHEN** two apps have the same `seconds`
- **THEN** they are ordered by `app_name`, so the order is the same on every call

### Requirement: App and website reports page by offset
<!-- source: WorkBeat Admin request (18 Nov 2026) -->
`GET /v1/reports/apps` and `/reports/websites` SHALL accept `offset` (integer, 0 to 100000, default 0) and return `next_offset`: the `offset` of the next page in the same order, or `null` when no row follows the page. An `offset` out of range MUST return `422 VALIDATION_FAILED`.

#### Scenario: Paging through websites
- **WHEN** a range has 230 domains and pages of 100 are read by following `next_offset`
- **THEN** the pages hold 100, 100 and 30 domains, none twice, and the last page's `next_offset` is `null`

#### Scenario: A bad offset
- **WHEN** `offset` is -1 or `abc`
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

### Requirement: App and website reports filter by category
<!-- source: WorkBeat Admin request (18 Nov 2026) · D1 -->
Both routes SHALL accept `category` (`productive`, `neutral` or `unproductive`) and then rank, limit and page only rows of that category, as the rules resolve it for the response. Any other `category` MUST return `422 VALIDATION_FAILED`.

#### Scenario: Unproductive sites past the top 100
- **WHEN** an employee has 150 domains of which 5 rank below 100 and are unproductive
- **THEN** `category=unproductive` lists all unproductive domains, those 5 included

#### Scenario: An unknown category
- **WHEN** `category` is `fun`
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

### Requirement: The activity report shows tracked time, activity percent and idle beside it
<!-- source: D1 · PRD "Activity levels, productivity, calendar and timesheets" · prototype "Activity by hour" -->
`GET /v1/reports/activity` SHALL return `tracked_seconds` (sum of `app_sessions.duration_seconds`), `activity_percent` (sum of `active_samples` / sum of `total_samples` over the same range, `null` without samples), `idle_seconds` from `idle_intervals`, and 24 hour-of-day rows in `companies.timezone` with both values averaged over days with data. Idle time MUST NOT be subtracted from tracked time.

#### Scenario: An employee was idle for an hour
- **WHEN** an employee had 8 h of foreground time including 1 h idle
- **THEN** `tracked_seconds` is 28800 and `idle_seconds` is 3600

#### Scenario: No samples
- **WHEN** the scope has sessions but no `activity_buckets` rows in the range
- **THEN** `activity_percent` is `null` and `tracked_seconds` is still summed

### Requirement: The productivity split counts browser time by site
<!-- source: PRD "Activity levels, productivity, calendar and timesheets" · prototype "Productivity split" -->
`GET /v1/reports/productivity` SHALL return `productive_seconds`, `neutral_seconds` and `unproductive_seconds`: app session seconds by app category, except sessions of the browser apps listed in `packages/shared`, plus URL visit seconds by domain category. It MUST also return `tracked_seconds` for the same scope and range.

#### Scenario: Time in a browser
- **WHEN** an employee spent 1 h in Chrome on `github.com`, a productive domain
- **THEN** that hour counts once, as productive, and not as Chrome's app category

### Requirement: A domain productivity rule covers its subdomains
<!-- source: PRD "Activity levels, productivity, calendar and timesheets" · serve-agent-policy/block-rules -->
A `productivity_rules` row with `match_type` `domain` SHALL match a visit whose `domain` equals the pattern or ends with `.` plus the pattern, compared case-insensitively. When several patterns match, the longest pattern MUST decide the category.

#### Scenario: A subdomain
- **WHEN** `github.com` is `productive` and a visit's `domain` is `docs.github.com`
- **THEN** the visit counts as productive

#### Scenario: A more specific rule
- **WHEN** `google.com` is `neutral` and `mail.google.com` is `productive`
- **THEN** a visit to `mail.google.com` counts as productive and one to `www.google.com` as neutral

#### Scenario: A look-alike domain
- **WHEN** `github.com` is `productive` and a visit's `domain` is `notgithub.com`
- **THEN** the visit counts as neutral

### Requirement: Activity and productivity can be grouped by period
<!-- source: Plan-v3.5 §4.5 "Reports" · B19 -->
`GET /v1/reports/activity` and `/reports/productivity` SHALL accept `group_by` `day`, `week` (Monday start) or `month` and then add `periods`: one row per period of the effective range, zeros included, with `period_start` (the period's first day, clipped to `from`), `tracked_seconds`, `activity_percent`, `productive_seconds`, `neutral_seconds` and `unproductive_seconds`. Any other value MUST answer `422`.

#### Scenario: Weeks of a month
- **WHEN** a report for 1–30 November is asked with `group_by` `week`
- **THEN** `periods` has one row per Monday-start week, the first starting 1 November

#### Scenario: An unknown grouping
- **WHEN** `group_by` is `year`
- **THEN** the response is `422 VALIDATION_FAILED`
