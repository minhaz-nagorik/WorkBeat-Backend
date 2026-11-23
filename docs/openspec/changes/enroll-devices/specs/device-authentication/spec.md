## Purpose

The device-key guard on every agent route: which key is accepted, the 401 and 402 answers the
agents branch on, and how an accepted request is bound to its device's company.

## ADDED Requirements

### Requirement: Agent routes authenticate with the device key
<!-- source: B3 · D6 · Mac enroll-device "device-credentials" -->
Every `/v1/agents/*` route SHALL resolve the SHA-256 of `X-Device-Key` through `auth_device`. A missing, unknown or replaced key MUST return `401 DEVICE_REVOKED`. These routes MUST NOT answer `404` for an unknown key.

#### Scenario: A key replaced by re-enrollment
- **WHEN** the previous key of a re-enrolled device calls `GET /v1/agents/policy`
- **THEN** the response is `401` with `code` `DEVICE_REVOKED`
- **AND** the new key of the same device is answered normally

#### Scenario: No key header
- **WHEN** a request to `POST /v1/agents/activity` carries no `X-Device-Key`
- **THEN** the response is `401` with `code` `DEVICE_REVOKED`, never `404`

### Requirement: A released device is told so
<!-- source: D38 · D45 · D48 · Plan-v3.5 §4.4 "Device release" · Mac enroll-device "device-release" -->
A key whose device has `released_at` set SHALL get `401 DEVICE_RELEASED`, with `released_at` and `upload_until` (`released_at` + 24 hours) in the error body, on every route in this guard except the upload routes during the window below, and that request MUST write nothing.

#### Scenario: A released Mac's next heartbeat
- **WHEN** a released device sends a heartbeat
- **THEN** the response is `401` with `code` `DEVICE_RELEASED`, `released_at` and `upload_until` = `released_at` + 24 hours
- **AND** `last_heartbeat_at` is unchanged

#### Scenario: Released while the company is suspended
- **WHEN** a released device of a suspended company calls `GET /v1/agents/policy`
- **THEN** the response is `401` with `code` `DEVICE_RELEASED`, not `402`

#### Scenario: A released Mac reports tamper
- **WHEN** a released device calls `POST /v1/agents/tamper` an hour after its release
- **THEN** the response is `401` with `code` `DEVICE_RELEASED` and no row is written

### Requirement: A released key uploads for 7 days
<!-- source: D45 · D48 · Plan-v3.5 §4.4 "Device release" · Plan-v3.5 §5.8 -->
For 7 days after `released_at` a released device's key SHALL be accepted on `POST /v1/agents/activity`, `POST /v1/agents/screenshots` and `POST /v1/agents/screenshots/:id/confirm`, storing records under that released binding and its `employee_id`. From 7 days after `released_at` on, these routes MUST answer `401 DEVICE_RELEASED` too.

#### Scenario: Uploading the buffer after a release
- **WHEN** a device released 2 hours ago sends an activity batch with its key
- **THEN** the batch is stored with the released row's `device_id` and `employee_id`

#### Scenario: Offline for ten days after the release
- **WHEN** a device released 8 days ago sends an activity batch with its key
- **THEN** the response is `401` with `code` `DEVICE_RELEASED` and nothing is written

#### Scenario: The device has a new binding
- **WHEN** a released device enrolled again as a new binding and then uploads with its released key
- **THEN** the records are stored under the released binding and its employee, never the new one

### Requirement: A released key uploads even while the company is suspended or expired
<!-- source: D38 · D45 · D48 · Plan-v3.5 §4.4 "Device release" -->
Inside its 7-day window a released key SHALL be accepted on the upload routes whatever the company's status: a release takes precedence over `402 COMPANY_SUSPENDED` and `402 LICENSE_EXPIRED`, so the device can upload what it holds and wipe.

#### Scenario: A suspended company released a laptop yesterday
- **WHEN** the released laptop sends `POST /v1/agents/activity` while the company is suspended
- **THEN** the batch is accepted under the released binding
- **AND** the laptop's heartbeat still gets `401 DEVICE_RELEASED`, not `402`

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
<!-- source: B2 · D48 · Plan-v3.5 §6.1 · Plan-v3.5 §4.4 "Binding history" -->
After the checks above, the request SHALL run in tenant scope of the key's `company_id`, with the key's `device_id` and `employee_id` (its binding) as the only device and employee it acts for. A `device_id`, `employee_id` or `company_id` in the body or query MUST NOT change them.

#### Scenario: A body names another device
- **WHEN** an authenticated agent sends a body carrying another device's `device_id`
- **THEN** the request acts only for the key's own device

#### Scenario: A query names another company
- **WHEN** an authenticated agent calls `GET /v1/agents/policy?company_id=` with another company's ID
- **THEN** the policy returned is the key's company's
- **AND** no row of the other company is read
