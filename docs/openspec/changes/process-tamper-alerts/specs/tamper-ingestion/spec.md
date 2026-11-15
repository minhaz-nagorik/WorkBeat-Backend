## Purpose

How `POST /v1/agents/tamper` stores one agent-reported tamper event exactly once, which event
types it accepts, and what it records about the device at that moment.

## ADDED Requirements

### Requirement: A tamper event is stored once on its ID
<!-- source: D24 · D13 · agent-contract.md "Payload fields" · detect-tampering/tamper-detection -->
`POST /v1/agents/tamper` with `id`, `event_type`, `detail`, `occurred_at` and `repeat_count` SHALL insert one `tamper_events` row and return `201` with `id` and `received_at`. A repeat of a stored `id` for the same device and `event_type` MUST return `200` with the stored values and write nothing.

#### Scenario: The response to a tamper report is lost
- **WHEN** the agent resends a stored event with the same `id`
- **THEN** the response is `200` with the first `received_at`
- **AND** one row exists for that `id`

#### Scenario: The repeat carries a higher repeat_count
- **WHEN** the agent resends a stored `id` with `repeat_count` 4 instead of 3
- **THEN** the response is `200` with the stored values and the row keeps `repeat_count` 3

#### Scenario: Two copies arrive at once
- **WHEN** two requests with the same new `id` from one device are handled concurrently
- **THEN** one gets `201` and the other `200`, and one row exists

#### Scenario: The same type again after a resolution
- **WHEN** a device reports a new `hosts_modified` event with a new `id` after the previous one was resolved
- **THEN** a second row is stored and the device is `tamper` again

### Requirement: A reused ID with different content is refused
<!-- source: D13 · agent-contract.md "Status and code catalog" -->
A stored `id` sent with another `event_type`, or by another device, SHALL get `409 IDEMPOTENCY_KEY_REUSED` and MUST write nothing.

#### Scenario: Two devices send the same ID
- **WHEN** device B sends an `id` already stored for device A
- **THEN** device B gets `409 IDEMPOTENCY_KEY_REUSED`
- **AND** device A's event is unchanged

#### Scenario: An ID stored for another company's device
- **WHEN** a device of company B sends an `id` stored for a device of company A
- **THEN** device B gets `409 IDEMPOTENCY_KEY_REUSED` and learns nothing of company A's event

### Requirement: Only the five agent event types are accepted
<!-- source: D24 · W11 · W14 · Plan-v3.2 §4.1 "Tamper detection" -->
`event_type` SHALL be one of `process_restart`, `hosts_modified`, `config_changed`, `clock_tampered` or `permission_revoked`. `offline` or any other value MUST get `422 VALIDATION_FAILED`; `repeat_count` MUST be at least 1 and `detail` a JSON object within the size limit in `packages/shared`.

#### Scenario: An agent sends offline
- **WHEN** a request carries `event_type` `offline`
- **THEN** the response is `422 VALIDATION_FAILED`
- **AND** no row is written

#### Scenario: repeat_count zero
- **WHEN** a request carries `repeat_count` 0
- **THEN** the response is `422 VALIDATION_FAILED` and no row is written

#### Scenario: detail over the limit
- **WHEN** `detail` is a JSON object one byte over the size limit in `packages/shared`
- **THEN** the response is `422 VALIDATION_FAILED`

#### Scenario: detail is an array
- **WHEN** `detail` is `[]`
- **THEN** the response is `422 VALIDATION_FAILED`

### Requirement: The event records the device as it was
<!-- source: D24 · D38 · data-model.md "tamper_events" · domain/tamper-events.md -->
The row SHALL carry the device's `company_id`, `device_id` and current `hostname` from the device key, `detail` as sent (facts only), `repeat_count` as sent and `received_at` from the server. An `occurred_at` later than the server time MUST be stored as the server time.

#### Scenario: The device is renamed later
- **WHEN** a device named `mac-17` reports an event and is later renamed
- **THEN** the event still shows `hostname` `mac-17`

#### Scenario: A clock running a day fast
- **WHEN** an event arrives with `occurred_at` 24 hours after the server time
- **THEN** it is stored with `occurred_at` equal to `received_at`

### Requirement: Events detected while offline are accepted at any age
<!-- source: D24 · D7 · design.md -->
An event SHALL be stored whatever the age of its `occurred_at`; the B7 window MUST NOT drop or refuse a tamper event.

#### Scenario: An event from ten days ago
- **WHEN** a device offline for ten days sends an event detected on its first day
- **THEN** it is stored with its original `occurred_at`

#### Scenario: An event detected during a monitoring pause
- **WHEN** a device of a paused employee reports a `config_changed` event
- **THEN** the event is stored and raises an alert like any other

### Requirement: An unresolved event makes the device tampered and raises an alert
<!-- source: PRD "Online status and tamper detection" · Plan-v3.2 §5.9 -->
A stored event SHALL stay unresolved until `resolved_at` is set; while it is, the device's derived status MUST be `tamper` (`device-status`, receive-device-health), and its first insertion MUST be handed to `alert-emails`.

#### Scenario: Hosts file edited
- **WHEN** a `hosts_modified` event is stored
- **THEN** `GET /v1/devices` shows the device as `tamper`

#### Scenario: A repeat is not a second alert
- **WHEN** a stored event's `id` is sent again
- **THEN** no alert email is handed over for the repeat

#### Scenario: A suspended company's device reports
- **WHEN** a device of a `suspended` company calls `POST /v1/agents/tamper`
- **THEN** the answer is `402` with `code` `COMPANY_SUSPENDED` and no row or alert is written
