## Purpose

The company's list of monitored people: who can add, edit, import, list and remove employees, and
why an employee who still has a device cannot be removed.

## ADDED Requirements

### Requirement: Company admins add and edit employees
<!-- source: PRD "Permission matrix" · Plan-v3.5 §4.4 "Employees and devices" -->
`POST /v1/employees` and `PATCH /v1/employees/:id` SHALL accept `name` (required, non-empty), `email` (required, a valid address; `PATCH` may leave it out but MUST NOT clear it), `department` and `manager_user_id`, and only from a `company_admin`; any other role MUST get `403 FORBIDDEN`. An `email` already held by a non-archived employee of the company MUST return `409 CONFLICT`. The employee MUST be written in the caller's company.

#### Scenario: An admin adds an employee
- **WHEN** a company admin posts `{ "name": "Ana Silva", "email": "ana@acme.com" }`
- **THEN** the response is `201` with the employee's `id`
- **AND** an `employees` row exists in the admin's company with `archived_at` NULL

#### Scenario: An IT admin tries to edit an employee
- **WHEN** an `it_admin` sends `PATCH /v1/employees/:id`
- **THEN** the response is `403` with `code` `FORBIDDEN` and nothing is written

#### Scenario: A duplicate email
- **WHEN** an admin adds an employee with the email of an existing non-archived employee
- **THEN** the response is `409` with `code` `CONFLICT`

#### Scenario: An email that differs only in case
- **WHEN** an admin adds `Ana@Acme.com` while a non-archived employee holds `ana@acme.com`
- **THEN** the response is `409` with `code` `CONFLICT`

#### Scenario: Two admins add the same email at once
- **WHEN** two `POST /v1/employees` with the same email are handled concurrently
- **THEN** one gets `201` and the other `409 CONFLICT`, and one row exists

#### Scenario: A name of only spaces
- **WHEN** an admin posts `{ "name": "   " }`
- **THEN** the response is `422` with `code` `VALIDATION_FAILED` naming `name`

#### Scenario: An employee without an email
- **WHEN** an admin adds an employee with no `email`, or clears the email of an existing one
- **THEN** the response is `422` with `code` `VALIDATION_FAILED` naming `email` and nothing is written

#### Scenario: A company_id in the body
- **WHEN** a company A admin posts an employee with `company_id` of company B
- **THEN** the employee is written in company A

### Requirement: The directory is readable per role
<!-- source: PRD "Permission matrix" · B12 · Plan-v3.5 §4.4 "Manager scoping" -->
`GET /v1/employees` and `GET /v1/employees/:id` SHALL return `id`, `name`, `email`, `department`, `manager_user_id` and `archived_at` to a `company_admin`, only `id`, `name`, `email` and `department` to an `it_admin` (B18), for every employee of their company, and to a `manager` only for their own team (`manager-teams`). Archived employees MUST be listed only when asked for with `archived=true`. An employee of another company MUST return `404 NOT_FOUND`.

#### Scenario: An IT admin lists employees
- **WHEN** an `it_admin` calls `GET /v1/employees`
- **THEN** every non-archived employee of their company is returned with `id`, `name`, `email` and `department` only

#### Scenario: Another company's employee
- **WHEN** a company admin requests `GET /v1/employees/:id` with an employee ID of another company
- **THEN** the response is `404` with `code` `NOT_FOUND`

#### Scenario: Archived employees on request
- **WHEN** a company admin calls `GET /v1/employees?archived=true`
- **THEN** archived employees are included, each with its `archived_at`

#### Scenario: A manager with no team
- **WHEN** a manager with no assigned employee calls `GET /v1/employees`
- **THEN** the response is `200` with an empty list

### Requirement: Employees are imported from CSV
<!-- source: PRD "Permission matrix" · Plan-v3.5 §4.4 "Employees and devices" -->
`POST /v1/employees/import` SHALL accept from a `company_admin` a CSV with the columns `name, email, department, manager email`, with or without a header row. A row with no or an invalid email MUST be reported as an invalid line. A row whose email matches a non-archived employee of the company MUST be skipped. A `manager email` MUST name a user with role `manager` in the company. The response MUST give `created`, `skipped` and the skipped emails.

#### Scenario: A file with a header row and an existing employee
- **WHEN** an admin imports a file with a header row and three rows, one with an existing employee's email
- **THEN** two employees are created and one row is skipped
- **AND** the response is `{ "data": { "created": 2, "skipped": 1, … } }`

#### Scenario: A manager email that is not a manager
- **WHEN** a row's `manager email` belongs to no `manager` of the company
- **THEN** the row is reported as invalid

#### Scenario: A file saved by Excel
- **WHEN** a file starts with a UTF-8 BOM and uses CRLF line endings
- **THEN** it is parsed the same as a plain UTF-8 file with LF endings and the BOM is not part of the first name

#### Scenario: A quoted field with a comma
- **WHEN** a row's name is `"Silva, Ana"`
- **THEN** the employee's `name` is `Silva, Ana`

#### Scenario: An email of an archived employee
- **WHEN** a row's email matches only an archived employee
- **THEN** a new employee is created for it

#### Scenario: The same file imported twice at once
- **WHEN** two imports of one file are handled concurrently
- **THEN** each email exists once among non-archived employees and the second import reports the rows the first created as skipped, or fails with nothing written

### Requirement: An invalid import writes nothing
<!-- source: B9 · PRD "Permission matrix" -->
An import with any invalid row (no `name`, a malformed email, an unknown manager email, or the same email twice in the file) SHALL return `422 VALIDATION_FAILED` naming each invalid line number, and MUST create no employee. A file over the import limit in `packages/shared` MUST return `413 PAYLOAD_TOO_LARGE`.

#### Scenario: One row has no name
- **WHEN** an admin imports 100 rows and row 57 has no name
- **THEN** the response is `422` with `code` `VALIDATION_FAILED` naming line 57
- **AND** no employee is created

#### Scenario: Duplicate emails inside the file
- **WHEN** lines 4 and 9 hold `ana@acme.com` and `ANA@acme.com`
- **THEN** the response is `422` with `code` `VALIDATION_FAILED` naming lines 4 and 9

#### Scenario: An unknown manager email
- **WHEN** line 12's `manager email` matches no enabled `manager` of the company
- **THEN** the response is `422` with `code` `VALIDATION_FAILED` naming line 12 and no employee is created

#### Scenario: An empty file
- **WHEN** a file has no data rows, or only a header row
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

#### Scenario: Exactly at and one over the row cap
- **WHEN** a valid file has exactly the row limit in `packages/shared`
- **THEN** it is imported
- **AND** a file with one more row gets `413` with `code` `PAYLOAD_TOO_LARGE`

### Requirement: Removing an employee archives them
<!-- source: D44 · D46 · D48 · Plan-v3.5 §4.4 "Employees and devices" · Plan-v3.5 §4.4 "Employee directory" -->
`DELETE /v1/employees/:id` from a `company_admin` SHALL set `archived_at` and keep the employee's rows and history. While the employee has any binding (`devices` row) with `released_at` NULL, deactivated or not, it MUST return `409 EMPLOYEE_HAS_DEVICES` and change nothing. An archived employee MUST NOT appear in `/license/validate` or get a new binding.

#### Scenario: The employee still has a laptop
- **WHEN** an admin removes an employee whose device is enrolled and not released
- **THEN** the response is `409` with `code` `EMPLOYEE_HAS_DEVICES`
- **AND** `archived_at` stays NULL

#### Scenario: Every device was released
- **WHEN** an admin removes an employee whose only device was released
- **THEN** `archived_at` is set and the employee's past activity is still in reports
- **AND** the employee's email can be used for a new employee

#### Scenario: A deactivated binding still blocks
- **WHEN** an admin removes an employee whose only binding is deactivated and not released
- **THEN** the response is `409` with `code` `EMPLOYEE_HAS_DEVICES` and `archived_at` stays NULL

#### Scenario: Removing an already archived employee
- **WHEN** an admin removes an employee whose `archived_at` is set
- **THEN** nothing changes and `archived_at` keeps its first value

#### Scenario: Archive races an enrollment
- **WHEN** an admin removes an employee while a device enrolls for that employee
- **THEN** either the removal answers `409 EMPLOYEE_HAS_DEVICES` or the enrollment answers `404 EMPLOYEE_NOT_FOUND`, never both succeeding

### Requirement: An archived employee is read-only
<!-- source: D47 · Plan-v3.5 §4.4 "Employees and devices" -->
`PATCH /v1/employees/:id`, `PUT /v1/employees/:id/monitoring-settings` and every pause write for an archived employee SHALL return `409 CONFLICT` and change nothing. Reads of an archived employee, their settings, pauses and history MUST keep working for the roles allowed to read them.

#### Scenario: An admin edits an archived employee
- **WHEN** a company admin patches the `department` of an archived employee
- **THEN** the response is `409` with `code` `CONFLICT`

#### Scenario: A pause for an archived employee
- **WHEN** a company admin posts a pause for an archived employee
- **THEN** the response is `409` with `code` `CONFLICT` and no pause is written

### Requirement: Employees carry a derived presence
<!-- source: Plan-v3.5 §4.5 "Employees" · B12 · B18 -->
`GET /v1/employees` and `GET /v1/employees/:id` SHALL add, for a `company_admin` and a `manager`, `presence`: the first that applies of `paused` (a pause in force), `no_device` (no device with `released_at` and `deactivated_at` NULL), `tamper` (one such device is `tamper`), `offline` (none of them is `online`), `active` (the latest `activity_buckets` row in the last 25 minutes has active samples), else `idle`. It MUST never be stored.

#### Scenario: A paused employee with a tampered laptop
- **WHEN** an employee has a pause in force and a device with an open tamper event
- **THEN** `presence` is `paused`

#### Scenario: An employee with only a released device
- **WHEN** every device of the employee is released
- **THEN** `presence` is `no_device`

#### Scenario: Working right now
- **WHEN** the employee's newest activity bucket from 4 minutes ago has 3 active samples
- **THEN** `presence` is `active`

#### Scenario: An online computer whose newest bucket arrived with the last sync
- **WHEN** the device heartbeated 3 minutes ago and the newest bucket started 18 minutes ago with active samples
- **THEN** `presence` is `active`

#### Scenario: No device online
- **WHEN** every live device of the employee is `offline`
- **THEN** `presence` is `offline`, whatever the buckets say

#### Scenario: The IT admin's list
- **WHEN** an `it_admin` lists employees
- **THEN** rows carry only `id`, `name`, `email` and `department`, without `presence`

### Requirement: Employees carry their devices
<!-- source: Plan-v3.5 §4.5 "Employees" · D48 -->
The same rows SHALL carry `devices`: the employee's devices with `released_at` NULL as `{ id, hostname, os, status, last_heartbeat_at }`, `status` as `device-status` (receive-device-health) derives it, so a `manager` sees their team's devices without `GET /v1/devices`.

#### Scenario: A manager opens an employee
- **WHEN** a manager reads an employee of their team who has one Mac
- **THEN** `devices` holds that Mac with its `status`

### Requirement: The directory filters by manager
<!-- source: B12 · manager-teams -->
`GET /v1/employees` SHALL accept `manager_user_id` and then return only employees with that `manager_user_id`, intersected with the caller's scope.

#### Scenario: The team of one manager
- **WHEN** a company admin lists employees with `manager_user_id` of manager M
- **THEN** every row has `manager_user_id` M
