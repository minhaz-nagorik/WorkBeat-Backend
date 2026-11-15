## Purpose

The device-key guard on every agent route: which key is accepted, the 401 and 402 answers the
agents branch on, and how an accepted request is bound to its device's company.

## ADDED Requirements

### Requirement: Agent routes authenticate with the device key
<!-- source: B3 · D6 · Mac enroll-device "device-credentials" -->
Every `/v1/agents/*` route and `POST /v1/devices/:id/deactivate` called without a user token SHALL resolve the SHA-256 of `X-Device-Key` through `auth_device`. A missing, unknown, replaced or deactivated key MUST return `401 DEVICE_REVOKED`. These routes MUST NOT answer `404` for an unknown key.

#### Scenario: The portal deactivated the device
- **WHEN** a deactivated device sends a heartbeat with its old key
- **THEN** the response is `401` with `code` `DEVICE_REVOKED`

#### Scenario: A key replaced by re-enrollment
- **WHEN** the previous key of a re-enrolled device calls `GET /v1/agents/policy`
- **THEN** the response is `401` with `code` `DEVICE_REVOKED`
- **AND** the new key of the same device is answered normally

#### Scenario: No key header
- **WHEN** a request to `POST /v1/agents/activity` carries no `X-Device-Key`
- **THEN** the response is `401` with `code` `DEVICE_REVOKED`, never `404`

### Requirement: A released device is told so
<!-- source: D38 · Mac enroll-device "device-release" -->
A key whose device has `released_at` set SHALL get `401 DEVICE_RELEASED` on every route in this guard, and the request MUST write nothing.

#### Scenario: A released Mac's next heartbeat
- **WHEN** a released device sends a heartbeat
- **THEN** the response is `401` with `code` `DEVICE_RELEASED`
- **AND** `last_heartbeat_at` is unchanged

#### Scenario: Released while the company is suspended
- **WHEN** a released device of a suspended company calls any agent route
- **THEN** the response is `401` with `code` `DEVICE_RELEASED`, not `402`

#### Scenario: A released Mac is uninstalled
- **WHEN** the uninstaller of a released device calls `POST /v1/devices/:id/deactivate` with its key
- **THEN** the response is `401` with `code` `DEVICE_RELEASED` and `deactivated_at` stays NULL

### Requirement: A suspended company gets 402 on every agent route
<!-- source: D5 · D29 · Mac report-device-health "suspended-company" -->
When the device's company has `status` `suspended`, every route in this guard, the heartbeat included, SHALL return `402 COMPANY_SUSPENDED`. When the company is restored, the next request MUST be answered normally.

#### Scenario: Suspended for non-payment
- **WHEN** a device of a suspended company sends a heartbeat
- **THEN** the response is `402` with `code` `COMPANY_SUSPENDED`

#### Scenario: Restored
- **WHEN** the company returns to `active` and the device sends a heartbeat
- **THEN** the response is not a `402`

### Requirement: An expired licence gets 402 with blocking_ends_at
<!-- source: D30 · D36 · Mac report-device-health "suspended-company" -->
When the device's company has `status` `expired`, every route in this guard SHALL return `402 LICENSE_EXPIRED` with `blocking_ends_at` = `licenses.expired_at` + `companies.expired_blocking_grace_days` days in the error body.

#### Scenario: Expired ten days ago
- **WHEN** a device calls an agent route ten days after `expired_at` with a 30-day grace
- **THEN** the response is `402` with `code` `LICENSE_EXPIRED`
- **AND** `blocking_ends_at` is `expired_at` + 30 days

#### Scenario: The grace period has passed
- **WHEN** a device calls an agent route 40 days after `expired_at` with a 30-day grace
- **THEN** the response is still `402` with `code` `LICENSE_EXPIRED`
- **AND** `blocking_ends_at` is the same past time, `expired_at` + 30 days

### Requirement: An accepted request runs as its device
<!-- source: B2 · Plan-v3.2 §6.1 -->
After the checks above, the request SHALL run in tenant scope of the key's `company_id`, with the key's `device_id` and `employee_id` as the only device and employee it acts for. A `device_id`, `employee_id` or `company_id` in the body or query MUST NOT change them.

#### Scenario: A body names another device
- **WHEN** an authenticated agent sends a body carrying another device's `device_id`
- **THEN** the request acts only for the key's own device

#### Scenario: A query names another company
- **WHEN** an authenticated agent calls `GET /v1/agents/policy?company_id=` with another company's ID
- **THEN** the policy returned is the key's company's
- **AND** no row of the other company is read

### Requirement: Deactivation is never refused for billing
<!-- source: B17 · D19 · D40 -->
`POST /v1/devices/:id/deactivate` called with a device key SHALL be exempt from the `402` answers: while the company is suspended or expired it MUST still deactivate the device and free its seat, so an uninstall never leaves a seat held.

#### Scenario: IT uninstalls a Mac while the company is suspended
- **WHEN** the uninstaller calls `POST /v1/devices/:id/deactivate` with the device key during a suspension
- **THEN** the response is `204`
- **AND** the device has `deactivated_at` set and no longer holds a seat

#### Scenario: The licence expired and the grace has passed
- **WHEN** the uninstaller of a device of an `expired` company past `blocking_ends_at` calls deactivate with its key
- **THEN** the response is `204` and the seat is freed
