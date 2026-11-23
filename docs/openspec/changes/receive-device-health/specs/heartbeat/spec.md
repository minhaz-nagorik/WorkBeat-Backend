## Purpose

What `POST /v1/agents/heartbeat` stores on the device row, what it answers, and how it keeps a
suspended device from showing as offline.

## ADDED Requirements

### Requirement: A heartbeat stores the latest health on the device
<!-- source: Plan-v3.5 §4.1 "Heartbeat", §4.4 "Ingestion and device health" · D39 · W11 · agent-contract.md "Payload fields" -->
The API SHALL write the heartbeat's `agent_version`, `policy_version` (as `reported_policy_version`), `helper_status`, `browser_access`, `permissions`, `active_pause_id` and, when sent, `os_version` to the device's row, and MUST keep only the latest values: no heartbeat history is stored. Windows `permissions` = `not_required` MUST be accepted (W11).

#### Scenario: A Mac reports Screen Recording pending
- **WHEN** a heartbeat carries `permissions` with Screen Recording `pending`
- **THEN** `devices.permissions` holds that value
- **AND** no other row records the heartbeat

#### Scenario: A Windows PC sends its heartbeat
- **WHEN** a heartbeat carries `permissions` = `not_required`
- **THEN** it is accepted with `200`

#### Scenario: A heartbeat with fields the contract does not name
- **WHEN** a heartbeat also carries `enrolled_via` and a field a newer agent added
- **THEN** it is accepted with `200`
- **AND** those fields are stored nowhere

#### Scenario: No os_version
- **WHEN** a heartbeat omits `os_version`
- **THEN** the stored `os_version` is kept and the other fields are written

### Requirement: A heartbeat may carry the time since the last input
<!-- source: employee-directory "Active means recent input on an online device" · Mac CHANGELOG 84 -->
A heartbeat MAY carry `input_idle_seconds`, the whole seconds since the last keyboard or mouse input the agent saw. The API SHALL store `devices.last_input_at` as the time it received the heartbeat minus that value, and NULL when the field is absent. A value that is not a whole number from 0 up MUST be treated as absent, never refused.

#### Scenario: Typed a minute ago
- **WHEN** a heartbeat carries `input_idle_seconds` 60
- **THEN** `devices.last_input_at` is one minute before the heartbeat was received

#### Scenario: An agent that does not send it
- **WHEN** a heartbeat omits `input_idle_seconds` or sends `-5`
- **THEN** it is accepted with `200` and `devices.last_input_at` is NULL

### Requirement: Counters and store health are kept in one health object
<!-- source: Plan-v3.5 §4.1 "Heartbeat" · D7 · D25 · report-device-health/heartbeat -->
The API SHALL store `store_bytes`, `oldest_unsent_at`, `dropped_records`, `dropped_samples`, `screenshot_skips`, `quarantined_batches`, `blocking_status`, `helper_restarts_24h`, `upload_failures_24h`, `update_failure` and `uptime_seconds` in `devices.health`, replacing the previous object.

#### Scenario: Records were dropped under the cap
- **WHEN** a heartbeat reports 120 dropped app sessions
- **THEN** `devices.health` carries that count
- **AND** the next heartbeat's counts replace it

#### Scenario: Every counter is zero
- **WHEN** a heartbeat reports every counter as 0 and `oldest_unsent_at` null
- **THEN** it is accepted and `devices.health` holds those values

### Requirement: A heartbeat marks the device seen
<!-- source: PRD "Online status and tamper detection" · B34 -->
Each accepted heartbeat SHALL set `devices.last_heartbeat_at` to the server time, in the same transaction as the health fields.

#### Scenario: An offline device comes back
- **WHEN** a device that last heartbeated an hour ago sends a heartbeat
- **THEN** `last_heartbeat_at` is the server time and its status is `online` at the next read

#### Scenario: The same heartbeat is sent twice
- **WHEN** a heartbeat's response was lost and the agent sends the same body again
- **THEN** both get `200` and the row holds the same values with a later `last_heartbeat_at`

### Requirement: The response carries the policy version and the pause in force
<!-- source: D31 · D32 · B5 · Plan-v3.5 §4.4 "Monitoring policy" -->
A `200` response SHALL carry `policy_version`, the device's resolved version as `agent-policy` (serve-agent-policy) computes it, and `monitoring_pause`: the employee's pause with `cancelled_at` null and `starts_at` ≤ now < `ends_at`, as `{ pause_id, starts_at, ends_at }`, or null when none is. With overlapping pauses it MUST return the one ending last.

#### Scenario: An admin extends a pause in force
- **WHEN** a pause until 17:00 is extended to 18:00
- **THEN** the next heartbeat response carries that `pause_id` with `ends_at` 18:00

#### Scenario: An admin cancels a pause in force
- **WHEN** the pause in force is cancelled
- **THEN** the next heartbeat response carries `monitoring_pause` null

#### Scenario: A pause that starts later today
- **WHEN** the employee's only pause starts in two hours
- **THEN** the response carries `monitoring_pause` null

#### Scenario: The pause boundaries
- **WHEN** a heartbeat is received exactly at a pause's `starts_at`
- **THEN** `monitoring_pause` carries that pause
- **AND** a heartbeat received exactly at its `ends_at` gets `monitoring_pause` null

### Requirement: A suspended or expired company's heartbeat is still recorded
<!-- source: D5 · D29 · D30 · D36 · enroll-devices/device-authentication -->
When `device-authentication` answers a heartbeat with `402` (`COMPANY_SUSPENDED` or `LICENSE_EXPIRED`), the API SHALL still write the health fields, `last_heartbeat_at` and the notice acknowledgement, and MUST return the `402` body unchanged. A heartbeat answered with `401` MUST write nothing.

#### Scenario: A suspended company's device stays online
- **WHEN** a device of a suspended company heartbeats every 5 minutes for an hour
- **THEN** each heartbeat gets `402 COMPANY_SUSPENDED`
- **AND** `last_heartbeat_at` is updated each time and the device stays `online`

#### Scenario: A released device calls once more
- **WHEN** a released device's heartbeat gets `401 DEVICE_RELEASED`
- **THEN** its row is not updated

#### Scenario: A replaced key calls once more
- **WHEN** the old key of a re-enrolled device heartbeats and gets `401 DEVICE_REVOKED`
- **THEN** no row is updated

#### Scenario: An ended company's hourly heartbeat
- **WHEN** a device of an `expired` company past `blocking_ends_at` heartbeats once an hour
- **THEN** each gets `402 LICENSE_EXPIRED` with `blocking_ends_at`
- **AND** `last_heartbeat_at` and the health fields are updated each time

### Requirement: A malformed heartbeat writes nothing
<!-- source: B9 · agent-contract.md "Status and code catalog" -->
A heartbeat failing its `packages/shared` schema SHALL be refused with `400` or `422 VALIDATION_FAILED` and MUST update no field, including `last_heartbeat_at`.

#### Scenario: A counter is negative
- **WHEN** a heartbeat carries `store_bytes` = -1
- **THEN** the response is `422 VALIDATION_FAILED`
- **AND** `last_heartbeat_at` is unchanged

#### Scenario: An unknown helper status
- **WHEN** a heartbeat carries `helper_status` `sleeping`
- **THEN** the response is `422 VALIDATION_FAILED` and no field is updated

### Requirement: Heartbeats never move the device back in time
<!-- source: Plan-v3.5 §6.4 · PRD "Online status and tamper detection" -->
`last_heartbeat_at` SHALL be set to the greater of its stored value and the server time of the heartbeat, and the health fields MUST hold the values of the heartbeat committed last. Heartbeats carry no client time, so arrival order decides.

#### Scenario: Two heartbeats of one device at once
- **WHEN** two heartbeats of one device are processed concurrently
- **THEN** the row holds the fields of the one committed last
- **AND** `last_heartbeat_at` is the later of the two server times

#### Scenario: A delayed retry arrives after a newer heartbeat
- **WHEN** a heartbeat retried after a timeout arrives after the next heartbeat
- **THEN** its fields replace the newer ones and `last_heartbeat_at` does not decrease
