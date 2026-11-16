## Purpose

How an employee is assigned to at most one manager, and how a manager's access is limited to
reading the employees assigned to them.

## ADDED Requirements

### Requirement: An employee has at most one manager
<!-- source: B12 · PRD "Users and roles" -->
An employee's manager SHALL be stored only in `employees.manager_user_id`, set or cleared by a `company_admin` through `POST /v1/employees`, `PATCH /v1/employees/:id` or the import. The value MUST be NULL or a user with role `manager` in the same company and not disabled; anything else MUST return `422 VALIDATION_FAILED`.

#### Scenario: An admin assigns a manager
- **WHEN** an admin sets `manager_user_id` to a manager of the company
- **THEN** the employee's `manager_user_id` is that user

#### Scenario: The user is an IT admin
- **WHEN** an admin sets `manager_user_id` to a user whose role is `it_admin`
- **THEN** the response is `422` with `code` `VALIDATION_FAILED` and nothing changes

#### Scenario: A user of another company
- **WHEN** an admin sets `manager_user_id` to a manager of another company
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

#### Scenario: A disabled manager
- **WHEN** an admin sets `manager_user_id` to a manager whose `disabled_at` is set
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

#### Scenario: An employee ID instead of a user ID
- **WHEN** an admin sets `manager_user_id` to an `employees.id`
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

#### Scenario: Clearing the manager
- **WHEN** an admin patches `manager_user_id` to `null`
- **THEN** the employee has no manager and no manager sees them

#### Scenario: Assignment races the manager's removal
- **WHEN** an admin assigns a manager while another admin removes that manager
- **THEN** the employee ends with either no manager or a manager who is still enabled

### Requirement: A manager reads only their own team
<!-- source: B12 · Plan-v3.5 §4.4 "Manager scoping" · PRD "API surface" -->
For a `manager`, every employee read in this change SHALL be limited to employees whose `manager_user_id` is that user. An employee outside the team MUST return `404 NOT_FOUND`, the same as an unknown ID. Reads in later changes (reports, screenshots, alerts) MUST apply the same filter.

#### Scenario: A manager lists employees
- **WHEN** a manager with three assigned employees calls `GET /v1/employees`
- **THEN** exactly those three are returned

#### Scenario: A manager opens another team's employee
- **WHEN** a manager requests `GET /v1/employees/:id/pauses` for an employee assigned to another manager
- **THEN** the response is `404` with `code` `NOT_FOUND`

#### Scenario: An employee moves to another team
- **WHEN** an admin moves an employee from manager M1 to M2
- **THEN** M1's next read of that employee answers `404 NOT_FOUND` and M2's answers `200`

#### Scenario: A manager asks for archived employees
- **WHEN** a manager calls `GET /v1/employees?archived=true`
- **THEN** only archived employees whose `manager_user_id` is that manager are included

### Requirement: A manager writes nothing
<!-- source: PRD "Users and roles" · PRD "Permission matrix" -->
A `manager` SHALL get `403 FORBIDDEN` on every write route in this change, including for employees of their own team: employees, import, monitoring settings and pauses.

#### Scenario: A manager tries to pause their report
- **WHEN** a manager posts a pause for an employee on their team
- **THEN** the response is `403` with `code` `FORBIDDEN` and no pause is written

#### Scenario: A manager imports a file
- **WHEN** a manager posts to `POST /v1/employees/import`
- **THEN** the response is `403` with `code` `FORBIDDEN` and the file is not parsed
