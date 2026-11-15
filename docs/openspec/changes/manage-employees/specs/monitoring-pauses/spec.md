## Purpose

Monitoring pauses: a window, set by a company admin for one employee, during which that
employee's devices collect nothing and block nothing, and how adding, extending or cancelling one
reaches the devices.

## ADDED Requirements

### Requirement: A company admin schedules a pause for one employee
<!-- source: D31 · Plan-v3.2 §4.4 "Monitoring policy" -->
`POST /v1/employees/:id/pauses` SHALL accept from a `company_admin` `starts_at` (omitted means the server's now), `ends_at`, `reason` (`annual_leave`, `sick_leave`, `personal`, `offsite_training`, `other`) and `note`, and write a `monitoring_pauses` row with `created_by`. A `starts_at` before now by more than the clock tolerance in `packages/shared`, or an `ends_at` not after `starts_at`, MUST return `422 VALIDATION_FAILED`.

#### Scenario: Pause now until Friday
- **WHEN** an admin posts `{ "ends_at": "<Friday 18:00>", "reason": "annual_leave" }`
- **THEN** the response is `201` with the pause `id`, which is the agents' `pause_id`
- **AND** `starts_at` is the server time of the request

#### Scenario: A start in the past
- **WHEN** an admin posts a `starts_at` of yesterday
- **THEN** the response is `422` with `code` `VALIDATION_FAILED` and nothing is written

#### Scenario: A start a moment ago
- **WHEN** an admin posts a `starts_at` that is earlier than the server time by no more than the clock tolerance in `packages/shared`
- **THEN** the pause is created with `starts_at` equal to the server time

#### Scenario: An end already in the past
- **WHEN** an admin posts no `starts_at` and an `ends_at` of one hour ago
- **THEN** the response is `422` with `code` `VALIDATION_FAILED` and nothing is written

### Requirement: Pauses for one employee never overlap
<!-- source: D31 · D34 -->
A create or extension that would make two non-cancelled pauses of the same employee overlap in time SHALL return `409 CONFLICT` and change nothing.

#### Scenario: A second pause inside the first
- **WHEN** an employee is paused 1–10 June and an admin adds a pause for 5–6 June
- **THEN** the response is `409` with `code` `CONFLICT`

#### Scenario: Back-to-back pauses
- **WHEN** an employee is paused until 10 June 18:00 and an admin adds a pause from 10 June 18:00
- **THEN** the second pause is created

#### Scenario: A cancelled pause does not block
- **WHEN** a pause for 1–10 June was cancelled and an admin adds a pause for 5–6 June
- **THEN** the new pause is created

#### Scenario: An extension into the next pause
- **WHEN** pauses exist for 1–5 and 8–12 June and an admin extends the first to 9 June
- **THEN** the response is `409` with `code` `CONFLICT` and the first keeps `ends_at` 5 June

#### Scenario: Two overlapping creates at once
- **WHEN** two admins create overlapping pauses for one employee concurrently
- **THEN** one gets `201` and the other `409 CONFLICT`

#### Scenario: Pauses of different employees
- **WHEN** two employees are paused over the same dates
- **THEN** both pauses are created

### Requirement: A pause is extended or cancelled, never deleted
<!-- source: D31 · D32 -->
`PATCH /v1/employees/:id/pauses/:pause_id` SHALL let a `company_admin` change `ends_at`, which MUST stay after `starts_at` and after now. `POST /v1/employees/:id/pauses/:pause_id/cancel` MUST set `cancelled_at` and `cancelled_by`. Either on a cancelled or ended pause MUST return `409 CONFLICT`. No route deletes a pause.

#### Scenario: Sick leave runs longer
- **WHEN** an admin moves an active pause's `ends_at` two days later
- **THEN** the pause keeps its `id` and has the new `ends_at`

#### Scenario: The employee comes back early
- **WHEN** an admin cancels an active pause
- **THEN** `cancelled_at` is set and the row remains

#### Scenario: A pause cancelled after it ended
- **WHEN** an admin cancels a pause whose `ends_at` passed yesterday
- **THEN** the response is `409` with `code` `CONFLICT` and `cancelled_at` stays NULL

#### Scenario: Cancelled twice
- **WHEN** an admin cancels a pause that is already cancelled
- **THEN** the response is `409` with `code` `CONFLICT` and `cancelled_at` keeps its first value

#### Scenario: A scheduled pause is cancelled
- **WHEN** an admin cancels a pause that has not started
- **THEN** `cancelled_at` is set and its `status` is `cancelled`

#### Scenario: An active pause is shortened into the past
- **WHEN** an admin sets an active pause's `ends_at` to ten minutes ago
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

#### Scenario: A pause ID of another employee
- **WHEN** an admin patches `/v1/employees/<A>/pauses/<pause of B>`
- **THEN** the response is `404` with `code` `NOT_FOUND`

### Requirement: Every pause change raises the employee's policy version
<!-- source: D31 · B5 · Mac report-device-health "monitoring-pause" -->
Creating, extending or cancelling a pause SHALL raise the employee's `employee_monitoring_settings.policy_version` in the same transaction, so every device of the employee sees it on its next heartbeat (`receive-device-health`) and policy (`serve-agent-policy`).

#### Scenario: A pause is cancelled
- **WHEN** an admin cancels a pause
- **THEN** the employee's `policy_version` is higher than before

#### Scenario: A refused change
- **WHEN** a pause create answers `409 CONFLICT`
- **THEN** the employee's `policy_version` is unchanged

### Requirement: Pauses are listed for the admin and the employee's manager
<!-- source: D31 · B12 · PRD "Users and roles" -->
`GET /v1/employees/:id/pauses` SHALL return each pause's `id`, `starts_at`, `ends_at`, `reason`, `note`, `created_by`, `cancelled_at` and a derived `status` (`scheduled`, `active`, `ended`, `cancelled`) to a `company_admin`, and read-only to a `manager` for their own team. An `it_admin` MUST get `403 FORBIDDEN`.

#### Scenario: A manager views a team member's leave
- **WHEN** a manager lists pauses for an employee on their team
- **THEN** the pauses are returned with their `status`

#### Scenario: An IT admin lists pauses
- **WHEN** an `it_admin` calls `GET /v1/employees/:id/pauses`
- **THEN** the response is `403` with `code` `FORBIDDEN`

#### Scenario: The status at the boundaries
- **WHEN** the server time equals a pause's `ends_at`
- **THEN** its `status` is `ended`, and at `starts_at` it is `active`
