## Purpose

How the collection-notice acknowledgement carried on the heartbeat becomes a permanent,
append-only record the company can show as evidence, and who can read it.

## ADDED Requirements

### Requirement: An acknowledgement is recorded once per binding and version
<!-- source: D25 · D46 · D48 · Plan-v3.5 §4.4 "Monitoring policy" · Plan-v3.5 §4.4 "Binding history" · report-device-health/heartbeat -->
When a heartbeat carries `notice_version` and `notice_acknowledged_at`, the API SHALL insert one `notice_acknowledgements` row with the binding's `device_id` and `employee_id`, the version, `acknowledged_at` from the agent and `received_at` from the server, unless a row for that binding and version exists. It MUST then set `devices.notice_ack_version` to the highest version acknowledged.

#### Scenario: The same acknowledgement rides on every heartbeat
- **WHEN** 12 heartbeats carry `notice_version` 3
- **THEN** exactly one row for that device and version 3 exists
- **AND** its `acknowledged_at` is the value from the first heartbeat

#### Scenario: Two heartbeats with the same acknowledgement at once
- **WHEN** two heartbeats carrying version 3 are processed concurrently
- **THEN** exactly one row for that device and version 3 exists and both heartbeats get `200`

#### Scenario: An acknowledgement of an older version
- **WHEN** the company is on version 4, the device has acknowledged 4 and a delayed heartbeat acknowledges 3
- **THEN** a row for version 3 is written if none exists
- **AND** `devices.notice_ack_version` stays 4

#### Scenario: A new binding on the same device acknowledges again
- **WHEN** employee A acknowledged version 3, the device was released and set up for employee B, and B acknowledges version 3
- **THEN** a second version 3 row exists for the new binding's `device_id`, carrying employee B

#### Scenario: An acknowledgement on a suspended company's heartbeat
- **WHEN** a heartbeat answered `402 COMPANY_SUSPENDED` carries `notice_version` 2
- **THEN** the version 2 row is written

### Requirement: An acknowledgement of an unknown version is ignored
<!-- source: D25 · B9 -->
An acknowledgement whose `notice_version` is greater than the company's `notice_version` SHALL NOT be recorded, and MUST NOT cause the heartbeat to fail.

#### Scenario: A version the company never published
- **WHEN** the company is on notice version 2 and a heartbeat acknowledges version 5
- **THEN** the heartbeat returns `200`
- **AND** no acknowledgement row is written

#### Scenario: The current version
- **WHEN** the company is on version 2 and a heartbeat acknowledges version 2
- **THEN** the row is written

### Requirement: Acknowledgements are append-only
<!-- source: D25 · D48 · PRD "Privacy" · Plan-v3.5 §4.4 "Binding history" -->
No route SHALL update or delete a `notice_acknowledgements` row. A release of the binding and a new binding on the same device MUST leave earlier rows with the binding and employee that acknowledged.

#### Scenario: A device changes hands by release
- **WHEN** a binding whose employee A acknowledged version 2 is released and the device is set up for employee B
- **THEN** the version 2 row still names A's binding and employee A

### Requirement: The company admin lists an employee's acknowledgements
<!-- source: D25 · Plan-v3.5 §4.5 "Employees" -->
`GET /v1/employees/:id/notice-acknowledgements` SHALL return, for a `company_admin`, every acknowledgement of that employee with `device_id`, the device's `hostname`, `notice_version`, `acknowledged_at` and `received_at`, newest first. Any other role MUST get `403 FORBIDDEN`; an employee of another company MUST get `404 NOT_FOUND`.

#### Scenario: A manager asks for acknowledgements
- **WHEN** a manager calls the route for an employee on their team
- **THEN** the response is `403 FORBIDDEN`

#### Scenario: An archived employee's evidence
- **WHEN** a company admin lists the acknowledgements of an archived employee
- **THEN** every row of that employee is returned

#### Scenario: An IT admin asks for acknowledgements
- **WHEN** an `it_admin` calls the route
- **THEN** the response is `403 FORBIDDEN`

#### Scenario: An admin asks for another company's employee
- **WHEN** a company admin passes the ID of another company's employee
- **THEN** the response is `404 NOT_FOUND`

### Requirement: A half acknowledgement is ignored
<!-- source: D25 · B9 · present-menu-bar-and-notices/employee-notices -->
A heartbeat carrying only one of `notice_version` and `notice_acknowledged_at` SHALL record no acknowledgement and MUST still store the rest of the heartbeat and answer as without it.

#### Scenario: A version without a time
- **WHEN** a heartbeat carries `notice_version` 3 and no `notice_acknowledged_at`
- **THEN** the heartbeat returns `200` and its health fields are stored
- **AND** no acknowledgement row is written
