## Purpose

The one call behind the dashboard: device counts, today's tracked time and activity, the latest
alerts and seats, each shown only to the roles allowed to see it.

## ADDED Requirements

### Requirement: The dashboard is one call shaped by role
<!-- source: Plan-v3.2 §4.5 "Dashboard" · D41 · B2 -->
`GET /v1/dashboard` SHALL run in `tenant` scope for `company_admin`, `manager` and `it_admin`, and return only the sections the role is allowed to see. `super_admin` MUST get `403 FORBIDDEN`.

#### Scenario: A staff user calls the dashboard
- **WHEN** a `super_admin` calls `GET /v1/dashboard`
- **THEN** the response is `403` with `code` `FORBIDDEN`

### Requirement: Device counts follow device status
<!-- source: Plan-v3.2 §4.5 "Dashboard" · Plan-v3.2 §5.9 · B12 -->
The response SHALL carry `devices` with `online`, `offline` and `tamper` counts as `device-status` (receive-device-health) derives them, excluding released and deactivated devices. `company_admin` and `it_admin` MUST count all the company's devices; `manager` MUST count only devices of employees whose `manager_user_id` is the caller.

#### Scenario: A manager's dashboard
- **WHEN** a manager with three team devices, one offline, opens the dashboard
- **THEN** `devices` is `online` 2, `offline` 1, `tamper` 0

#### Scenario: A device both offline and tampered
- **WHEN** a device is offline and has an open tamper event
- **THEN** it is counted once, under the status `device-status` derives for it

#### Scenario: A company with no devices
- **WHEN** a company with no devices opens the dashboard
- **THEN** `devices` is `online` 0, `offline` 0, `tamper` 0

### Requirement: Today's activity is shown to report readers only
<!-- source: D1 · PRD "Users and roles" · Plan-v3.2 §4.5 "Dashboard" -->
For `company_admin` and `manager` the response SHALL carry `today` with `tracked_seconds` and `activity_percent` for the caller's scope from local midnight in `companies.timezone`, computed as `usage-reports` computes them. For `it_admin` the response MUST NOT carry `today`.

#### Scenario: An IT admin's dashboard
- **WHEN** an `it_admin` opens the dashboard
- **THEN** the response has `devices` and `alerts` but no `today` and no `seats`

#### Scenario: Just after local midnight
- **WHEN** a company in `Asia/Dhaka` opens the dashboard at 00:05 Dhaka time
- **THEN** `today` covers only the five minutes since Dhaka midnight

### Requirement: Recent alerts come from the alerts feed
<!-- source: Plan-v3.2 §4.5 "Dashboard" · PRD "Users and roles" -->
The response SHALL carry `alerts`: the newest five entries the caller would see in `alerts-feed` (process-tamper-alerts), with that capability's fields and role scoping.

#### Scenario: Six open alerts
- **WHEN** the company has six alerts visible to the caller
- **THEN** `alerts` holds the newest five

### Requirement: Seats are shown to the company admin
<!-- source: D43 · B4 · prototype "Seats used" -->
For `company_admin` the response SHALL carry `seats` with `used` (devices neither deactivated nor released) and `limit` (`licenses.seat_limit`, `null` when unlimited). Other roles MUST NOT receive `seats`.

#### Scenario: 49 of 50 seats
- **WHEN** a company has 49 active devices and a seat limit of 50
- **THEN** `seats` is `{ used: 49, limit: 50 }`

#### Scenario: More used than the limit
- **WHEN** a company uses 30 seats after its limit was lowered to 10
- **THEN** `seats` is `{ used: 30, limit: 10 }`
