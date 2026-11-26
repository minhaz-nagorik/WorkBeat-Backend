## Purpose

How a binding ends: release from monitoring is the only way, what it does to the key and the seat,
what an uninstall does, and why a binding's employee never changes. There is no deactivate (B35);
the uninstaller ends the binding and records the uninstall (B36).

## ADDED Requirements

### Requirement: There is no deactivate
<!-- source: B35 · product owner 23 Nov 2026 -->
`POST /v1/devices/:id/deactivate` SHALL NOT exist, with a user token or a device key, and MUST answer `404 NOT_FOUND`. No route MUST set `devices.deactivated_at`; the column stays in the schema unused, so every device counts as not deactivated.

#### Scenario: A client still calls deactivate
- **WHEN** a portal user or an old uninstaller calls `POST /v1/devices/:id/deactivate`
- **THEN** the response is `404` with `code` `NOT_FOUND` and the device is unchanged

### Requirement: The uninstaller ends the binding
<!-- source: B36 · B35 · D19 -->
`POST /v1/agents/uninstall` with a device key SHALL set `released_at` when it is not set, set `uninstalled_at`, clear `key_hash` and answer `204`, freeing the seat and the employee as a release does. The key MUST then answer `401 DEVICE_REVOKED` on every route, including this one. The database MUST refuse `uninstalled_at` without `released_at`.

#### Scenario: IT uninstalls a laptop
- **WHEN** IT runs the uninstaller with the right token on an enrolled laptop that is online
- **THEN** the seat count drops by one, the device shows `uninstalled`, and its next heartbeat gets `401 DEVICE_REVOKED`

#### Scenario: The uninstaller calls twice
- **WHEN** the first call succeeded and the uninstaller calls again with the same key
- **THEN** the response is `401` with `code` `DEVICE_REVOKED` and the device is unchanged

#### Scenario: Removed without the uninstaller
- **WHEN** WorkBeat is deleted from a laptop without the uninstaller and nobody releases it
- **THEN** the seat count is unchanged and the device shows `offline` 15 minutes after its last heartbeat

### Requirement: An uninstall needs no approval and works in any company state
<!-- source: B36 · D19 · D38 -->
The uninstall token checked on the computer SHALL be the approval: the route MUST NOT go through the maker-checker step and MUST NOT answer `402`. A released key MUST be accepted at any time after its release.

#### Scenario: Uninstalled after a release
- **WHEN** a device released three weeks ago is then uninstalled with the uninstaller
- **THEN** the response is `204`, `released_at` keeps its first value and the device shows `uninstalled`

#### Scenario: Uninstalled while the company is suspended
- **WHEN** the company is suspended and the uninstaller calls the route
- **THEN** the response is `204` and the seat is freed

### Requirement: The portal releases a device from monitoring
<!-- source: D38 · D45 · D48 · Plan-v3.5 §5.8 · Plan-v3.5 §4.4 "Device release" -->
`POST /v1/devices/:id/release` from a `company_admin` or `it_admin` SHALL end the binding: set `released_at`, keep `key_hash` (for the upload window in `device-authentication`) and free the seat and the employee. A released device MUST answer `401 DEVICE_RELEASED` and stay in the device list with status `released` (`receive-device-health`). Releasing it again MUST return `409 CONFLICT`.

#### Scenario: A laptop handed back to IT
- **WHEN** an admin releases a device
- **THEN** the seat is freed and the device's next heartbeat gets `401 DEVICE_RELEASED`

#### Scenario: The device's next enrollment
- **WHEN** a released device enrolls again for any employee
- **THEN** a new binding is made and the released row keeps its `employee_id` and `released_at`

#### Scenario: Release an already released device
- **WHEN** an admin releases a device with `released_at` set
- **THEN** the response is `409` with `code` `CONFLICT`
- **AND** `released_at` keeps its first value

### Requirement: A binding's employee never changes
<!-- source: D48 · Plan-v3.5 §4.4 "Device binding" · Plan-v3.5 §6.2 "devices" -->
No route SHALL change a `devices` row's `employee_id` after it is inserted, and the database MUST refuse an `UPDATE` that changes it. There is no route that moves a device to another employee; to give it to someone else it is released and set up again, which makes a new binding.

#### Scenario: A direct update of the employee
- **WHEN** any statement updates `devices.employee_id` of an existing row to another value
- **THEN** the database refuses it and the row keeps its employee

#### Scenario: Handing a laptop to a new hire
- **WHEN** IT releases a device bound to employee A and runs Setup on it for employee B
- **THEN** a new `devices` row bound to B exists and the released row still names A

### Requirement: Lifecycle routes stay inside the company
<!-- source: B2 · Plan-v3.5 §6.1 · PRD "Permission matrix" -->
A `manager` SHALL get `403 FORBIDDEN` on release. A device key MUST only ever uninstall its own device. A device ID of another company MUST return `404 NOT_FOUND` to a portal user.

#### Scenario: Another company's device
- **WHEN** an `it_admin` releases a device ID that belongs to another company
- **THEN** the response is `404` with `code` `NOT_FOUND` and nothing changes

#### Scenario: A manager tries to release
- **WHEN** a `manager` calls `POST /v1/devices/:id/release` for a device of their own team
- **THEN** the response is `403` with `code` `FORBIDDEN`

### Requirement: A lifecycle change keeps the device's history
<!-- source: D38 · D44 · D48 · data-model.md "Ingested data" · Plan-v3.5 §4.4 "Binding history" -->
Release SHALL change only the `devices` row. It MUST NOT delete or rewrite the device's `app_sessions`, `url_visits`, `activity_buckets`, `idle_intervals`, `screenshots`, `tamper_events` or `notice_acknowledgements`; their removal belongs to `data-retention` (run-scheduled-jobs).

#### Scenario: A released laptop's reports
- **WHEN** an admin releases a device that recorded a month of activity
- **THEN** that activity and its screenshots are still stored with their original `employee_id`

#### Scenario: Set up again after a release
- **WHEN** a released device is set up again and gets a new binding
- **THEN** its earlier records keep the released row's `device_id`
