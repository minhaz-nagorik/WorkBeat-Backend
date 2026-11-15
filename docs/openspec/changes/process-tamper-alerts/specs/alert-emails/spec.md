## Purpose

Which users are emailed about tamper and offline events, when, through which delivery mode, and
what an alert email can and cannot contain.

## ADDED Requirements

### Requirement: Recipients follow the company's alert settings
<!-- source: Plan-v3.2 §4.4 "Ingestion and device health" · PRD "Permission matrix" · data-model.md "companies" -->
An event SHALL be emailed only when its `event_type` is in `companies.alert_email.types`, to the company's users whose role is in `alert_email.roles` and who have no `disabled_at`. A `manager` MUST be emailed only for devices whose employee is on their team, and no `super_admin` MUST ever be a recipient.

#### Scenario: Managers are among the roles
- **WHEN** a tamper event is raised on a device of employee A, managed by M1
- **THEN** M1 is emailed and the company's other managers are not

#### Scenario: The type is not selected
- **WHEN** `alert_email.types` does not include `clock_tampered`
- **THEN** no email is sent for a `clock_tampered` event

#### Scenario: No recipient matches
- **WHEN** `alert_email.roles` is empty, or no enabled user holds a listed role
- **THEN** no email is sent and the event gets `emailed_at`

#### Scenario: A manager with no team device
- **WHEN** `alert_email.roles` is `["manager"]` and the device's employee has no manager
- **THEN** no email is sent and the event gets `emailed_at`

#### Scenario: A disabled admin
- **WHEN** a company admin has `disabled_at` set
- **THEN** they receive no alert email

### Requirement: Instant delivery sends within one minute
<!-- source: PRD "Success metrics" · Plan-v3.2 §4.4 -->
With `alert_email.delivery` `instant`, the API SHALL send one email per event through Resend within 1 minute of storing it, from `POST /v1/agents/tamper` or `/cron/heartbeat-check`, after the event is committed.

#### Scenario: An offline device
- **WHEN** `/cron/heartbeat-check` raises an `offline` event for an instant-delivery company
- **THEN** the recipients receive one email within 1 minute

#### Scenario: Delivery switched from instant to daily
- **WHEN** an event was stored, its instant email failed, and the company then switched to `daily`
- **THEN** the event is sent once, in the next daily digest

### Requirement: Digests are sent by a scheduled job
<!-- source: Plan-v3.2 §3 "Scheduled jobs", §6.4 · B10 -->
`/cron/alert-digest`, run every hour (authentication owned by `cron-routes`, run-scheduled-jobs), SHALL send one email per recipient listing the unemailed events of the last hour for `hourly` companies, and of the last 24 hours at the run that falls at 09:00 in the company's `timezone` for `daily` companies.

#### Scenario: Hourly digest
- **WHEN** three events are raised between 10:00 and 11:00 for an hourly company
- **THEN** each recipient gets one email listing the three at the 11:00 run

#### Scenario: No events in the hour
- **WHEN** an hourly company has no unemailed event
- **THEN** the run sends it no email

#### Scenario: A half-hour time zone
- **WHEN** a daily company's `timezone` is `Asia/Kolkata`
- **THEN** its digest is sent by the run at 03:30 UTC, the one inside the 09:00–09:59 local hour

#### Scenario: A daylight-saving change
- **WHEN** a daily company in `America/New_York` passes the day clocks move
- **THEN** it receives exactly one daily digest that day, in its local 09:00 hour

#### Scenario: The digest job overlaps itself
- **WHEN** a second `/cron/alert-digest` call arrives while one runs
- **THEN** it answers `skipped` = `true` and no recipient receives a second digest

### Requirement: Each event is emailed once
<!-- source: data-model.md "tamper_events" · D13 -->
An event SHALL get `emailed_at` once Resend has accepted its email for every recipient, or once it has no recipient, and an event with `emailed_at` set MUST never be emailed again. An instant email that failed MUST be retried by the next `/cron/alert-digest` run if the event is less than 24 hours old.

#### Scenario: Resend is down
- **WHEN** an instant email fails
- **THEN** `emailed_at` stays null
- **AND** the next digest run sends it and sets `emailed_at`

#### Scenario: One of three recipients fails
- **WHEN** Resend accepts the email for two recipients and refuses the third
- **THEN** `emailed_at` stays NULL and the retry sends to all three, so no recipient misses it, even if one receives it twice

#### Scenario: An outage longer than a day
- **WHEN** Resend is down for 30 hours after an instant event
- **THEN** the event is not emailed after it is 24 hours old, `emailed_at` stays NULL and the drop is logged by event ID

### Requirement: An alert email carries no activity content
<!-- source: D4 · D41 · PRD "Privacy" -->
An alert email SHALL contain the event type, the device `hostname`, the employee name, `occurred_at` and `repeat_count` only. It MUST NOT contain `detail`, a URL or domain the employee visited, a window title or any signed URL.

#### Scenario: A hosts_modified email
- **WHEN** an email is sent for a `hosts_modified` event
- **THEN** it holds no hash, file path or domain from the event's `detail`

#### Scenario: The subject line
- **WHEN** any alert email is sent
- **THEN** its subject holds only the event type and the hostname

### Requirement: A missed digest run loses nothing
<!-- source: Plan-v3.2 §3 "Scheduled jobs" · D13 · B19 -->
Each digest SHALL list every unemailed event of the recipient's scope received within 24 hours for an `hourly` company and within 48 hours for a `daily` company, not only those of the last period, so a run the scheduler missed is caught up by the next one. Events MUST be listed once, newest first.

#### Scenario: The scheduler skipped two runs
- **WHEN** the 10:00 and 11:00 runs never happened and an hourly company had events at 09:30 and 10:30
- **THEN** the 12:00 run lists both in one email per recipient

#### Scenario: The 09:00 daily run was missed
- **WHEN** a daily company's local 09:00 run did not happen
- **THEN** the next day's 09:00 digest lists the unemailed events of the last 48 hours
