## Purpose

How a device leaves or moves: deactivation by the portal or the uninstaller, release from
monitoring, and reassignment to another employee, and what each does to the key and the seat.

## ADDED Requirements

### Requirement: The portal deactivates a device
<!-- source: D6 · Plan-v3.2 §5.8 · PRD "Permission matrix" -->
`POST /v1/devices/:id/deactivate` with a user token SHALL be accepted from a `company_admin` or `it_admin` and set `deactivated_at` and clear `key_hash`, freeing the seat; any other role MUST get `403 FORBIDDEN`. Repeating it MUST return the device unchanged; on a released device it MUST return `409 CONFLICT`.

#### Scenario: IT deactivates a laptop
- **WHEN** an `it_admin` deactivates a device
- **THEN** the seat count drops by one
- **AND** the device's next call gets `401 DEVICE_REVOKED`

#### Scenario: Deactivate is sent twice
- **WHEN** an admin deactivates a device that is already deactivated
- **THEN** the response is `200` with the device unchanged
- **AND** `deactivated_at` keeps its first value and the seat count does not change

#### Scenario: Deactivate a released device
- **WHEN** an admin deactivates a device with `released_at` set
- **THEN** the response is `409` with `code` `CONFLICT` and nothing changes

### Requirement: The uninstaller deactivates its own device
<!-- source: D19 · D40 · agent-contract.md "Routes" -->
`POST /v1/devices/:id/deactivate` with `X-Device-Key` (`device-authentication`) SHALL deactivate the key's device as the portal does and return `204`. An `:id` that is not the key's device MUST return `403 FORBIDDEN` and change nothing.

#### Scenario: A clean uninstall
- **WHEN** the uninstaller calls deactivate with its own `device_id` and key
- **THEN** the response is `204` and the seat is freed

#### Scenario: Another device's ID
- **WHEN** a device key calls deactivate with another device's ID
- **THEN** the response is `403` with `code` `FORBIDDEN`
- **AND** neither device changes

#### Scenario: The uninstaller retries after a lost response
- **WHEN** the uninstaller's deactivate committed and it calls again with the same key
- **THEN** the response is `401` with `code` `DEVICE_REVOKED`, because the key was cleared
- **AND** the device stays deactivated with its first `deactivated_at`

### Requirement: The portal releases a device from monitoring
<!-- source: D38 · Plan-v3.2 §5.8 -->
`POST /v1/devices/:id/release` from a `company_admin` or `it_admin` SHALL set `released_at`, keep `key_hash` and free the seat. A released device MUST answer `401 DEVICE_RELEASED` (`device-authentication`), raise no offline alert, and stay in the device list with status `released` (`receive-device-health`). Releasing it again MUST return `409 CONFLICT`.

#### Scenario: A laptop handed back to IT
- **WHEN** an admin releases a device
- **THEN** the seat is freed and the device's next call gets `401 DEVICE_RELEASED`

#### Scenario: A deactivated device is released
- **WHEN** an admin releases a device that was deactivated
- **THEN** `released_at` is set and its employee can be removed

#### Scenario: Release an already released device
- **WHEN** an admin releases a device with `released_at` set
- **THEN** the response is `409` with `code` `CONFLICT`
- **AND** `released_at` keeps its first value

### Requirement: A device is reassigned to another active employee only
<!-- source: D44 · B5 · Plan-v3.2 §4.4 "Employees and devices" -->
`POST /v1/devices/:id/reassign` from a `company_admin` or `it_admin` SHALL set `employee_id` to a non-archived employee of the same company and raise the device's `policy_version`. A missing or null `employee_id` MUST return `400 VALIDATION_FAILED`, another employee `404 EMPLOYEE_NOT_FOUND`, a released device `409 CONFLICT`.

#### Scenario: The laptop moves to a new hire
- **WHEN** an admin reassigns a device to another active employee
- **THEN** the device's `employee_id` is the new employee and its `policy_version` rises
- **AND** activity recorded before keeps the previous `employee_id`

#### Scenario: Reassign to nobody
- **WHEN** an admin sends `{ "employee_id": null }`
- **THEN** the response is `400` with `code` `VALIDATION_FAILED`

#### Scenario: Reassign to an archived employee
- **WHEN** an admin reassigns a device to an employee with `archived_at` set
- **THEN** the response is `404` with `code` `EMPLOYEE_NOT_FOUND` and `employee_id` is unchanged

#### Scenario: Reassign to another company's employee
- **WHEN** an admin reassigns a device to an employee ID of another company
- **THEN** the response is `404` with `code` `EMPLOYEE_NOT_FOUND`

#### Scenario: Reassign to the employee it already has
- **WHEN** an admin reassigns a device to its current `employee_id`
- **THEN** the response is `200` and the device's `policy_version` does not change

#### Scenario: Reassign a released device
- **WHEN** an admin reassigns a device with `released_at` set
- **THEN** the response is `409` with `code` `CONFLICT`

#### Scenario: Reassign a deactivated device
- **WHEN** an admin reassigns a deactivated device to another active employee
- **THEN** the response is `200` and the device still holds no seat

### Requirement: Lifecycle routes stay inside the company
<!-- source: B2 · Plan-v3.2 §6.1 · PRD "Permission matrix" -->
A `manager` SHALL get `403 FORBIDDEN` on deactivate, release and reassign. A device ID of another company MUST return `404 NOT_FOUND` to a portal user.

#### Scenario: Another company's device
- **WHEN** an `it_admin` releases a device ID that belongs to another company
- **THEN** the response is `404` with `code` `NOT_FOUND` and nothing changes

#### Scenario: A manager tries to reassign
- **WHEN** a `manager` calls `POST /v1/devices/:id/reassign` for a device of their own team
- **THEN** the response is `403` with `code` `FORBIDDEN`

### Requirement: A lifecycle change keeps the device's history
<!-- source: D38 · D44 · data-model.md "Ingested data" -->
Deactivate, release and reassign SHALL change only the `devices` row. They MUST NOT delete or rewrite the device's `app_sessions`, `url_visits`, `activity_buckets`, `idle_intervals`, `screenshots`, `tamper_events` or `notice_acknowledgements`; their removal belongs to `data-retention` (run-scheduled-jobs).

#### Scenario: A released laptop's reports
- **WHEN** an admin releases a device that recorded a month of activity
- **THEN** that activity and its screenshots are still stored with their original `employee_id`

#### Scenario: Deactivated then re-enrolled
- **WHEN** a deactivated device re-enrolls on the same row
- **THEN** its earlier records keep the same `device_id`
