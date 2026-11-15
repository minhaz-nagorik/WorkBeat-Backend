## Purpose

The CSV exports a company admin or manager downloads: raw app sessions, URL visits and daily
summaries for a range, with the same scope as reports and a bounded size.

## ADDED Requirements

### Requirement: Three CSV exports exist
<!-- source: Plan-v3.2 §4.4 "Reports and data lifecycle" · PRD "Activity levels, productivity, calendar and timesheets" -->
The API SHALL serve `GET /v1/exports/app-sessions.csv`, `/exports/url-visits.csv` and `/exports/daily-summaries.csv`, taking the range and scope parameters of `usage-reports`. Each row MUST carry the employee name and email, and times MUST be ISO 8601 with the `companies.timezone` offset. Session and visit rows MUST carry their productivity `category` resolved at export time.

#### Scenario: Daily summaries for a team
- **WHEN** an admin exports daily summaries for a manager's team over one week
- **THEN** one row per employee per day holds tracked seconds, activity percent and the three productivity seconds

#### Scenario: An offset across daylight saving
- **WHEN** an export of a company in `Europe/London` spans the day clocks go back
- **THEN** times before the change carry `+01:00` and times after carry `+00:00`

#### Scenario: No rows
- **WHEN** an export's range and scope hold no rows
- **THEN** the response is `200` with only the header row

### Requirement: Exports follow report access
<!-- source: D41 · B2 · B12 · PRD "Users and roles" -->
Export routes SHALL run in `tenant` scope and allow only `company_admin` (all employees) and `manager` (own team). `it_admin` and `super_admin` MUST get `403 FORBIDDEN`. An export MUST contain only rows of the caller's company and scope.

#### Scenario: A manager exports URL visits
- **WHEN** a manager exports URL visits without a scope parameter
- **THEN** only visits of employees whose `manager_user_id` is the manager are in the file

#### Scenario: A manager names an employee outside the team
- **WHEN** a manager exports with `employee_id` of another manager's employee
- **THEN** the response is `404` with `code` `NOT_FOUND`

### Requirement: An export is bounded by a row cap
<!-- source: Plan-v3.2 §6.3 -->
An export SHALL be built in one request, and when it would exceed the row cap in `packages/shared` it MUST get `422 EXPORT_TOO_LARGE` with the cap, and no partial file. Ranges MUST be validated and clamped as in `usage-reports`.

#### Scenario: A year of sessions for the whole company
- **WHEN** an export would hold more rows than the cap
- **THEN** the response is `422` with `code` `EXPORT_TOO_LARGE`

#### Scenario: Exactly at the cap
- **WHEN** an export holds exactly the row cap
- **THEN** the full file is returned
- **AND** one row more gets `422 EXPORT_TOO_LARGE`

### Requirement: Exported cells cannot run as formulas
<!-- source: prototype "Export CSV" -->
Every export SHALL be UTF-8 CSV with a header row, `Content-Type: text/csv` and a `Content-Disposition` file name. A cell starting with `=`, `+`, `-`, `@`, tab or carriage return MUST be prefixed with `'`, and a cell with a comma, quote or line break MUST be quoted.

#### Scenario: A window title starts with an equals sign
- **WHEN** an app session's `window_title` is `=HYPERLINK("x")`
- **THEN** the cell is written as `"'=HYPERLINK(""x"")"`

#### Scenario: A non-Latin title
- **WHEN** a `window_title` holds `会議メモ`
- **THEN** the cell holds those characters encoded in UTF-8
