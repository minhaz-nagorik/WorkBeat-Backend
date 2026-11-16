## Purpose

How the backend, and only the backend, decides a device has gone silent and raises one `offline`
event for it, without flagging released, deactivated or ended devices.

## ADDED Requirements

### Requirement: A silent device is marked offline every 5 minutes
<!-- source: Plan-v3.5 §6.4 · PRD "Online status and tamper detection" -->
Each run of `/cron/heartbeat-check` (scheduled every 5 minutes; route and authentication owned by `cron-routes` in run-scheduled-jobs) SHALL set `offline_since` on every device whose `last_heartbeat_at`, or `enrolled_at` when it never sent one, is more than 15 minutes old and whose `offline_since` is null. The threshold MUST come from `packages/shared`.

#### Scenario: A laptop is shut for an hour
- **WHEN** a device's last heartbeat was 16 minutes ago
- **THEN** the next run sets its `offline_since`

#### Scenario: A device heartbeats on time
- **WHEN** a device's last heartbeat was 6 minutes ago
- **THEN** it is not marked offline

#### Scenario: Exactly 15 minutes
- **WHEN** a device's last heartbeat was exactly 15 minutes before the run
- **THEN** it is not marked offline

#### Scenario: Enrolled but never heard from
- **WHEN** a device enrolled 20 minutes ago and has `last_heartbeat_at` null
- **THEN** the run sets its `offline_since`

#### Scenario: A suspended company's silent device
- **WHEN** a device of a suspended company has not heartbeated for 20 minutes
- **THEN** the run marks it offline like any other device

### Requirement: One offline event per offline period
<!-- source: D24 · Plan-v3.5 §4.1 "Tamper detection" -->
Marking a device offline SHALL insert exactly one `tamper_events` row with a server-made `id`, `event_type` `offline`, the device's current `hostname`, `occurred_at` = the time of the run and `detail` holding `last_heartbeat_at`. Later runs, including concurrent ones, MUST NOT insert another until a heartbeat has cleared `offline_since`.

#### Scenario: A device stays silent for a day
- **WHEN** a device is silent for 24 hours
- **THEN** exactly one `offline` event exists for that period

#### Scenario: Two runs at once
- **WHEN** two runs of the job overlap
- **THEN** each silent device gets one `offline_since` and one `offline` event

#### Scenario: A second offline period
- **WHEN** a device came back, was cleared, and went silent again
- **THEN** a second `offline` event is raised and the first stays resolved

### Requirement: Released, deactivated and ended devices are never flagged
<!-- source: D36 · D38 · Plan-v3.5 §4.4 "Employees and devices", §6.3 -->
The job MUST skip devices with `released_at` or `deactivated_at` set, and devices of a company whose licence expired and whose `blocking_ends_at` has passed, because those devices heartbeat only hourly.

#### Scenario: A device is released
- **WHEN** a released device sends nothing for a week
- **THEN** no `offline` event is raised for it

#### Scenario: An expired company's grace period has ended
- **WHEN** a device of a company past `blocking_ends_at` last heartbeated 50 minutes ago
- **THEN** it is not marked offline

#### Scenario: An expired company inside its grace
- **WHEN** a device of an `expired` company before `blocking_ends_at` is silent for 20 minutes
- **THEN** it is marked offline

#### Scenario: A deactivated device that never heartbeats
- **WHEN** a deactivated device has been silent for a day
- **THEN** no `offline` event is raised for it

### Requirement: Offline is raised only by the backend
<!-- source: D24 · detect-tampering/tamper-detection · agent-contract.md "Payload fields" -->
An `offline` event SHALL be created only by `/cron/heartbeat-check`. `POST /v1/agents/tamper` with `event_type` `offline` is refused as `tamper-ingestion` (process-tamper-alerts) says.

#### Scenario: Only the job writes offline
- **WHEN** offline events are listed
- **THEN** every one has a server-made `id` written by the job

### Requirement: A device that returns during the run is not left offline
<!-- source: Plan-v3.5 §6.4 · D24 · PRD "Online status and tamper detection" -->
The job SHALL set `offline_since` and insert the `offline` event in one transaction, re-checking `last_heartbeat_at` and `offline_since` on the locked row. A heartbeat committed before that row is marked MUST keep the device online; one arriving after MUST clear `offline_since` and resolve the event.

#### Scenario: The heartbeat commits first
- **WHEN** a device's heartbeat commits after the job selected it but before the job updates its row
- **THEN** the device is not marked offline and no `offline` event is written

#### Scenario: The heartbeat waits on the job
- **WHEN** a heartbeat arrives while the job holds the device's row
- **THEN** after the job commits, the heartbeat sets `offline_since` null and sets `resolved_at` on the new event
