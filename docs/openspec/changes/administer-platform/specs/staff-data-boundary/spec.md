## Purpose

The line WorkBeat staff never cross: no staff route reads or returns employee, device, activity,
URL or screenshot data, and the tests that prove it on every build.

## ADDED Requirements

### Requirement: Staff routes read only staff tables
<!-- source: D41 · B2 · Plan-v3.2 §6.1 -->
Every `/v1/staff/*` route SHALL run in `staff` scope with no `app.company_id` and read only `companies`, `licenses`, `users`, `invitations`, `agent_releases` and `stripe_events`, plus `company_seat_counts()`. A staff route MUST NOT set `app.company_id` or `system` scope.

#### Scenario: A staff route needs seat counts
- **WHEN** `GET /v1/staff/companies` runs
- **THEN** it reads seat counts from `company_seat_counts()` and never queries `devices`

#### Scenario: A staff route asks for system scope
- **WHEN** a staff route's code tries to set `app.scope` = `system`
- **THEN** the request fails with `500 INTERNAL` and no query runs in `system` scope

### Requirement: Staff responses hold no employee data
<!-- source: D41 · PRD "Permission matrix" · Plan-v3.2 §4.6 -->
No staff route response SHALL contain an employee name or email, a device hostname, serial or hardware ID, an app name, window title, URL, domain visited, screenshot path or signed URL, or any activity value.

#### Scenario: Staff open a company detail
- **WHEN** a `super_admin` calls `GET /v1/staff/companies/:id`
- **THEN** the response carries no employee, device or activity field

#### Scenario: An error from a staff route
- **WHEN** a staff route fails while handling a company
- **THEN** the error body holds only `error` and `code`, with no tenant value

### Requirement: Tenant tables are empty in staff scope
<!-- source: D41 · B2 -->
In `staff` scope, every read of `employees`, `employee_monitoring_settings`, `monitoring_pauses`, `devices`, `enrollment_tokens`, the four activity tables, `screenshots`, `tamper_events` and the policy tables SHALL return no rows, enforced by row-level security as well as by the route.

#### Scenario: A staff query on devices
- **WHEN** a query on `devices` runs in a staff transaction
- **THEN** it returns zero rows

#### Scenario: A staff query that names a company
- **WHEN** a staff transaction selects `employees` with `company_id` = a real company's ID
- **THEN** it returns zero rows

### Requirement: A staff token reads no tenant data in CI
<!-- source: Plan-v3.2 §8 "One sign-in for staff and company users" · D41 -->
CI SHALL seed two companies with employees, devices, activity and screenshots, then call every staff route and every company route with a `super_admin` token. The build MUST fail if any company route answers other than `403 FORBIDDEN` or any staff response contains a seeded employee, device, URL or screenshot value.

#### Scenario: A new route leaks a hostname
- **WHEN** a change adds a staff route that returns a device hostname
- **THEN** the CI boundary test fails and the change cannot merge
