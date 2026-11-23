## Purpose

How a binding ends: release from monitoring is the only way, what it does to the key and the seat,
what an uninstall does, and why a binding's employee never changes. There is no deactivate (B35).

## ADDED Requirements

### Requirement: There is no deactivate
<!-- source: B35 · product owner 23 Nov 2026 -->
`POST /v1/devices/:id/deactivate` SHALL NOT exist, with a user token or a device key, and MUST answer `404 NOT_FOUND`. No route MUST set `devices.deactivated_at`; the column stays in the schema unused, so every device counts as not deactivated.

#### Scenario: A client still calls deactivate
- **WHEN** a portal user or an old uninstaller calls `POST /v1/devices/:id/deactivate`
- **THEN** the response is `404` with `code` `NOT_FOUND` and the device is unchanged

### Requirement: Only a release frees a seat
<!-- source: B35 · D19 -->
The API SHALL have no route a device calls to end its own binding: a device MUST keep its seat and its employee until a `company_admin` or `it_admin` releases it, including after WorkBeat is uninstalled from it, and shows `offline` once its heartbeats stop.

#### Scenario: IT uninstalls a laptop
- **WHEN** IT runs the uninstaller on an enrolled laptop and nobody releases it
- **THEN** the seat count is unchanged and the device shows `offline` 15 minutes after its last heartbeat

#### Scenario: Released after the uninstall
- **WHEN** an admin releases that device later
- **THEN** its seat and employee are freed

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
A `manager` SHALL get `403 FORBIDDEN` on release. A device ID of another company MUST return `404 NOT_FOUND` to a portal user.

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
