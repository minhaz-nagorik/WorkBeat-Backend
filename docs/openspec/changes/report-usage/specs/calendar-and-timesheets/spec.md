## Purpose

The per-employee calendar (day, week, month) and the Monday-start weekly timesheet, in JSON and
as a PDF, with day boundaries in the company's time zone.

## ADDED Requirements

### Requirement: Days follow the company's time zone
<!-- source: PRD "Activity levels, productivity, calendar and timesheets" · data-model.md "companies" -->
Every calendar, timesheet and dashboard day SHALL run from local midnight to midnight in the IANA zone in `companies.timezone` (default `UTC`), and a timesheet week MUST start on Monday in that zone. Each row MUST be attributed to the day of its start time.

#### Scenario: A company in Asia/Dhaka
- **WHEN** `companies.timezone` is `Asia/Dhaka` and a session starts at 19:00 UTC on Monday
- **THEN** it counts on Tuesday

#### Scenario: The clocks go forward
- **WHEN** a company in `America/New_York` has a session at 02:30 UTC on the day clocks spring forward
- **THEN** it counts on the local day it started, and that day has 23 hours

#### Scenario: A session over midnight
- **WHEN** a session starts at 23:30 and ends at 00:30 local time
- **THEN** all of it counts on the day it started

### Requirement: The calendar returns one row per day
<!-- source: PRD "Activity levels, productivity, calendar and timesheets" · D1 · Plan-v3.2 §4.4 -->
`GET /v1/employees/:id/calendar?view=day|week|month&date=YYYY-MM-DD` SHALL return one row per day of that day, Monday-start week or calendar month, each with `date`, `tracked_seconds`, `activity_percent`, `productive_seconds`, `neutral_seconds`, `unproductive_seconds` and `paused`, computed as `usage-reports` computes them. Days outside retention MUST be omitted.

#### Scenario: A month view
- **WHEN** an admin asks for `view=month&date=2026-11-10`
- **THEN** rows for 1–30 November are returned, zero on days without data

#### Scenario: A paused day
- **WHEN** a non-cancelled `monitoring_pauses` row overlaps a day
- **THEN** that day's row has `paused` = `true`

#### Scenario: A week across a month end
- **WHEN** an admin asks for `view=week&date=2026-12-02`
- **THEN** rows for Monday 30 November to Sunday 6 December are returned

#### Scenario: A day partly paused
- **WHEN** a pause ends at 12:00 local time on a day
- **THEN** that day's row has `paused` = `true` and its tracked time after 12:00

#### Scenario: A cancelled pause
- **WHEN** a pause overlapping a day was cancelled
- **THEN** that day's row has `paused` = `false`

### Requirement: The timesheet covers one employee for one week
<!-- source: PRD "Activity levels, productivity, calendar and timesheets" · prototype "Weekly timesheet" -->
`GET /v1/employees/:id/timesheet?week=YYYY-MM-DD` SHALL return the employee's name and email, the company name and seven day rows with `date`, `first_activity_at`, `last_activity_at`, `tracked_seconds`, `activity_percent`, the three productivity seconds and `paused`, plus week totals. A `week` that is not a Monday MUST get `422 VALIDATION_FAILED`.

#### Scenario: A Wednesday is given
- **WHEN** `week=2026-11-11` (a Wednesday) is requested
- **THEN** the response is `422` with `code` `VALIDATION_FAILED` naming `week`

#### Scenario: A week across a daylight-saving change
- **WHEN** a timesheet week of a company in `Europe/London` contains the day clocks go back
- **THEN** seven day rows are returned and that day's row covers 25 hours

#### Scenario: A day with no activity
- **WHEN** an employee has no rows on Wednesday
- **THEN** Wednesday's `first_activity_at` and `last_activity_at` are `null` and its seconds 0

### Requirement: The timesheet is generated as a PDF
<!-- source: PRD "Activity levels, productivity, calendar and timesheets" · Plan-v3.2 §4.4 -->
`GET /v1/employees/:id/timesheet.pdf?week=YYYY-MM-DD` SHALL return `200` with `Content-Type: application/pdf` and a `Content-Disposition` file name holding the employee and week, generated on request from the same values as the JSON timesheet. The PDF MUST NOT be stored.

#### Scenario: An admin downloads a timesheet
- **WHEN** an admin requests the PDF for a Monday week
- **THEN** a PDF with the seven days and totals is returned and nothing is written

#### Scenario: A name with characters unsafe in a file name
- **WHEN** the employee's name is `Ana/Silva "QA"`
- **THEN** the `Content-Disposition` file name holds no slash or quote

### Requirement: Calendar and timesheet follow report access
<!-- source: D41 · B12 · PRD "Users and roles" -->
The calendar and timesheet routes SHALL allow `company_admin` for any employee of the company and `manager` only for an employee whose `manager_user_id` is the caller. Any other employee MUST get `404 NOT_FOUND`; `it_admin` and `super_admin` MUST get `403 FORBIDDEN`.

#### Scenario: Another company's employee
- **WHEN** an admin requests the calendar of an employee ID from another company
- **THEN** the response is `404` with `code` `NOT_FOUND`

#### Scenario: A manager opens a team member's timesheet
- **WHEN** a manager requests the timesheet of an employee they manage
- **THEN** the response is `200`

#### Scenario: An IT admin asks for a timesheet
- **WHEN** an `it_admin` requests `GET /v1/employees/:id/timesheet.pdf`
- **THEN** the response is `403` with `code` `FORBIDDEN` and no PDF is built
