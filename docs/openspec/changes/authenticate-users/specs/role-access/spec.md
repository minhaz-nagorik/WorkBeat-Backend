## Purpose

What each of the four roles is allowed to do on the portal and staff routes, how a manager is limited to
their own team, and what a caller gets for a route or a record outside their reach.

## ADDED Requirements

### Requirement: Every route checks the caller's role
<!-- source: Plan-v3.5 §4.4 "Role guard", §4.5 · PRD "Permission matrix" -->
Every portal and staff route SHALL declare the roles it allows, and the API MUST refuse every other role with `403 FORBIDDEN` before the route reads data. Hiding a page in the web platform MUST NOT be the control.

#### Scenario: A manager opens the block list editor
- **WHEN** a manager calls a route that writes `block_rules`
- **THEN** the response is `403` with `code` `FORBIDDEN`
- **AND** nothing is written

#### Scenario: A route without a role declaration
- **WHEN** a portal route is registered without declared roles
- **THEN** the API refuses to start

#### Scenario: A forbidden role on another company's record
- **WHEN** a manager calls a write route with an ID of another company
- **THEN** the response is `403 FORBIDDEN`, because the role is checked before any data is read

### Requirement: Areas follow the permission matrix
<!-- source: Plan-v3.5 §4.5 · PRD "Permission matrix", "Users and roles" -->
Routes SHALL allow: onboarding and deployment to `company_admin`; installer downloads and devices to `company_admin` and `it_admin`; employees, the block list, productivity rules and sensitive domains to `company_admin` and `it_admin` (writes by `it_admin` wait for approval, `change-approvals`), read by `manager`; reports and screenshots to `company_admin` and `manager` (own team); alerts to all three (manager: own team).

#### Scenario: An IT admin asks for a report
- **WHEN** an `it_admin` calls a usage report route
- **THEN** the response is `403 FORBIDDEN`

#### Scenario: An IT admin lists devices
- **WHEN** an `it_admin` calls the device list route
- **THEN** the response is `200`

#### Scenario: An IT admin opens screenshots
- **WHEN** an `it_admin` calls a screenshot route
- **THEN** the response is `403 FORBIDDEN`

#### Scenario: A manager reads productivity rules
- **WHEN** a `manager` reads productivity rules and then tries to change one
- **THEN** the read is `200` and the change is `403 FORBIDDEN`

### Requirement: Company-admin-only areas and the IT admin's limits
<!-- source: Plan-v3.5 §4.5 · PRD "Roles" · B18 · D48 · Plan-v3.5 §4.4 "Device binding" -->
Settings, team, licence key, uninstall token, minimum agent version and setup checklist SHALL be reachable by `company_admin` only; billing and the staff-managed settings by no company role (B29). `it_admin` SHALL read employees with the `company_admin` fields, monitoring settings and pauses, and MUST reach no report, calendar, timesheet, screenshot, export or notice acknowledgement.

#### Scenario: An IT admin opens billing
- **WHEN** an `it_admin` calls `GET /v1/billing`
- **THEN** the response is `403 FORBIDDEN`

#### Scenario: An IT admin lists employees
- **WHEN** an `it_admin` calls `GET /v1/employees`
- **THEN** each employee carries the `company_admin` fields, `presence` and `manager_user_id` included

#### Scenario: An IT admin reveals the licence key
- **WHEN** an `it_admin` calls `POST /v1/license/reveal`
- **THEN** the response is `403 FORBIDDEN`

### Requirement: Company routes and staff routes never cross
<!-- source: D41 · Plan-v3.5 §4.5, §4.6 -->
A `super_admin` SHALL get `403 FORBIDDEN` on every company route, and every company role SHALL get `403 FORBIDDEN` on every `/v1/staff/*` route.

#### Scenario: A company admin calls the staff area
- **WHEN** a `company_admin` calls `GET /v1/staff/companies`
- **THEN** the response is `403 FORBIDDEN`

#### Scenario: Staff call a company route
- **WHEN** a `super_admin` calls `GET /v1/team`
- **THEN** the response is `403 FORBIDDEN`

### Requirement: A manager reaches only their own team
<!-- source: B12 · Plan-v3.5 §4.4 "Manager scoping" · PRD "Permission matrix" -->
Every route open to `manager` SHALL filter `employees` and every row keyed by `employee_id` to employees whose `manager_user_id` is the caller. An employee outside the team MUST answer `404 NOT_FOUND`, and lists MUST NOT include them. A manager MUST NOT write employee, monitoring or pause data.

#### Scenario: A manager opens another manager's employee
- **WHEN** a manager requests the report of an employee whose `manager_user_id` is someone else
- **THEN** the response is `404` with `code` `NOT_FOUND`

#### Scenario: A manager lists employees
- **WHEN** a manager lists employees
- **THEN** only employees with `manager_user_id` = the manager are returned

#### Scenario: A manager filters a list by another manager
- **WHEN** a manager calls a list route with `manager_user_id` of another manager
- **THEN** the response is `403 FORBIDDEN` and no employee of that team is returned

#### Scenario: A team member moves to another manager mid-session
- **WHEN** an admin moves an employee away from manager M while M's session is open
- **THEN** M's next request for that employee answers `404 NOT_FOUND`

### Requirement: Another company's record answers 404
<!-- source: Plan-v3.5 §6.1 · B2 -->
A path or query ID that names a record of another company SHALL answer `404 NOT_FOUND`, the same as an ID that does not exist, and MUST NOT reveal that the record exists.

#### Scenario: A company admin guesses an ID
- **WHEN** a company A admin requests an employee ID that belongs to company B
- **THEN** the response is `404 NOT_FOUND`

