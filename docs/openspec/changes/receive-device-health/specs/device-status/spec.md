## Purpose

The status and badges the portal shows for each device, derived from stored fields at read time,
and the device list and rollout counts that serve them to admins and IT.

## ADDED Requirements

### Requirement: Status is derived in a fixed order and never stored
<!-- source: Plan-v3.2 §2.4, §5.9 · D38 · D44 -->
A device's `status` SHALL be computed at read time as the first that applies: `released` (`released_at` set), `deactivated` (`deactivated_at` set), `tamper` (an unresolved tamper event other than `offline`), `offline` (`offline_since` set), else `online`. No column MUST store it, and there MUST be no `unassigned` status.

#### Scenario: A tampered device goes offline
- **WHEN** a device has an unresolved `hosts_modified` event and `offline_since` set
- **THEN** its status is `tamper`

#### Scenario: A released device had tamper events
- **WHEN** a released device has unresolved tamper events
- **THEN** its status is `released`

#### Scenario: A deactivated device was offline
- **WHEN** a device has `deactivated_at` and `offline_since` set
- **THEN** its status is `deactivated`

#### Scenario: Enrolled minutes ago
- **WHEN** a device enrolled 3 minutes ago and has not heartbeated
- **THEN** its status is `online`

### Requirement: Badges flag what IT must act on
<!-- source: Plan-v3.2 §5.7, §5.9 · W11 · D31 · D39 -->
Each device SHALL carry `badges`: `outdated` when `agent_version` is below the effective minimum (`agent-releases`, distribute-agents), `permission_pending` when a macOS `permissions` entry is not granted, `browser_access_pending` when a `browser_access` entry is `pending` or `unreadable`, and `paused` when `active_pause_id` is set or a pause is in force. Windows MUST never be `permission_pending`.

#### Scenario: A Mac awaits Screen Recording approval
- **WHEN** a Mac's `permissions` reports Screen Recording `pending`
- **THEN** its badges include `permission_pending`

#### Scenario: A device below the minimum
- **WHEN** a device runs 1.0.2 and the effective minimum is 1.0.4
- **THEN** its badges include `outdated`

#### Scenario: Exactly on the minimum
- **WHEN** a device runs 1.0.4 and the effective minimum is 1.0.4
- **THEN** its badges do not include `outdated`

#### Scenario: Versions compared as numbers
- **WHEN** a device runs 1.10.0 and the effective minimum is 1.9.0
- **THEN** its badges do not include `outdated`

#### Scenario: A pause in force the agent has not seen yet
- **WHEN** an employee's pause started a minute ago and the device's `active_pause_id` is null
- **THEN** the device's badges include `paused`
- **AND** a pause that starts tomorrow adds no badge

#### Scenario: A Windows PC
- **WHEN** a Windows device reports `permissions` `not_required`
- **THEN** its badges never include `permission_pending`

### Requirement: Admins and IT list the company's devices
<!-- source: Plan-v3.2 §4.5 "Devices" · PRD "Permission matrix" -->
`GET /v1/devices` SHALL return, for a `company_admin` or `it_admin`, the company's devices with `id`, `hostname`, `os`, `os_version`, `arch`, `agent_version`, employee `id` and `name`, `status`, `badges` and `last_heartbeat_at`, filterable by `status`, `badge`, `os` and `employee_id`. `GET /v1/devices/:id` SHALL add `helper_status`, `browser_access`, `permissions` and `health`. A `manager` MUST get `403 FORBIDDEN`.

#### Scenario: IT filters offline devices
- **WHEN** an IT admin calls `GET /v1/devices?status=offline`
- **THEN** only the company's offline devices are returned

#### Scenario: An archived employee's devices
- **WHEN** an employee was archived after their devices were released or deactivated
- **THEN** those devices are still listed with that employee's `id` and `name`

#### Scenario: A filter by another company's employee
- **WHEN** an IT admin filters by an `employee_id` of another company
- **THEN** the response is `200` with an empty list

#### Scenario: A manager opens the device list
- **WHEN** a manager calls `GET /v1/devices`
- **THEN** the response is `403 FORBIDDEN`

### Requirement: The rollout dashboard counts devices by status and badge
<!-- source: Plan-v3.2 §5.9 · D44 -->
`GET /v1/rollout` SHALL return, for a `company_admin` or `it_admin`, the company's device counts per `status` and per badge, and `healthy`: devices `online` with no badge. A `manager` MUST get `403 FORBIDDEN`.

#### Scenario: A fresh rollout
- **WHEN** a company has 10 online devices, 2 of them `permission_pending`, and 1 released
- **THEN** `GET /v1/rollout` reports `online` 10, `permission_pending` 2, `healthy` 8 and `released` 1

#### Scenario: A company with no devices
- **WHEN** a company has no device
- **THEN** every count is 0 and `healthy` is 0

### Requirement: Device data never crosses a company
<!-- source: Plan-v3.2 §6.1 · D41 · B2 -->
`GET /v1/devices`, `GET /v1/devices/:id` and `GET /v1/rollout` SHALL read only the caller's company. A device ID of another company MUST return `404 NOT_FOUND`, and a `super_admin` MUST get `403 FORBIDDEN`.

#### Scenario: An admin asks for another company's device
- **WHEN** a company admin calls `GET /v1/devices/:id` with another company's device ID
- **THEN** the response is `404 NOT_FOUND`

#### Scenario: A super admin opens the device list
- **WHEN** a `super_admin` calls `GET /v1/devices`
- **THEN** the response is `403 FORBIDDEN` and no device is read
