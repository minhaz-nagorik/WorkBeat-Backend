## Purpose

The in-app alerts feed: which tamper and offline events each role sees, how they are filtered and
resolved, and how fresh the feed is.

## ADDED Requirements

### Requirement: The feed lists the company's events by role
<!-- source: PRD "Permission matrix" · Plan-v3.5 §4.5 "Dashboard" · D48 · Plan-v3.5 §4.4 "Binding history" -->
`GET /v1/alerts` SHALL return the company's `tamper_events`, newest `occurred_at` first, each with `id`, `event_type`, `device_id`, `hostname`, the binding's employee `id` and `name`, `detail`, `repeat_count`, `occurred_at`, `received_at`, `resolved_at` and `resolved_by`. A `company_admin` or `it_admin` MUST see every binding; a `manager` MUST see only bindings whose employee is on their team.

#### Scenario: A manager opens the feed
- **WHEN** a manager calls `GET /v1/alerts`
- **THEN** only events of devices whose employee they manage are returned

#### Scenario: An employee moves to another manager
- **WHEN** a binding's employee moves from manager M1 to M2
- **THEN** that device's past and new events appear in M2's feed and no longer in M1's

#### Scenario: A company with no events
- **WHEN** a company admin calls `GET /v1/alerts` for a company with no `tamper_events`
- **THEN** the response is `200` with an empty list and no next cursor

#### Scenario: An event of a released device
- **WHEN** a device with an event was released
- **THEN** the event is still listed with its snapshot `hostname`

#### Scenario: A used device set up for another employee
- **WHEN** a binding of employee A with an event is released and the device is set up for employee B on M2's team
- **THEN** the event still names employee A and is not in M2's feed unless A is on M2's team

### Requirement: The feed is filtered and paged
<!-- source: Plan-v3.5 §4.5 "Dashboard" · B9 -->
`GET /v1/alerts` SHALL accept `type` (one or more event types, comma-separated), `state` (`open` or `resolved`), `device_id`, `employee_id`, `from`, `to` and `cursor`, and MUST return `{ items, next_cursor, counts }`: at most the page size in `packages/shared`, the next cursor, and `counts` per `event_type` for the same filters without `type` and `cursor`.

#### Scenario: IT reviews open offline alerts
- **WHEN** an IT admin calls `GET /v1/alerts?type=offline&state=open`
- **THEN** only unresolved `offline` events are returned

#### Scenario: Events with the same occurred_at across a page break
- **WHEN** several events share one `occurred_at` and a page ends among them
- **THEN** the next page continues with the following event in `(occurred_at, id)` order, with none repeated or skipped

#### Scenario: The last page is full
- **WHEN** exactly a page size of events matches
- **THEN** one page is returned and the next cursor is `null`

#### Scenario: Reversed dates
- **WHEN** `to` is before `from`
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

#### Scenario: A device of another company
- **WHEN** `device_id` names a device of another company
- **THEN** the response is `200` with an empty list

### Requirement: Admins and IT resolve an alert
<!-- source: Plan-v3.5 §5.9 "Tamper: review the event details" -->
`POST /v1/alerts/:id/resolve` SHALL set `resolved_at` and `resolved_by` for a `company_admin` or `it_admin` and return the event. Resolving a resolved event MUST return it unchanged. A `manager` MUST get `403 FORBIDDEN`; another company's event MUST get `404 NOT_FOUND`.

#### Scenario: IT closes a reviewed event
- **WHEN** an IT admin resolves the device's only open tamper event
- **THEN** the event carries `resolved_at` and `resolved_by`
- **AND** the device no longer has the `open_alert` badge

#### Scenario: A manager tries to resolve
- **WHEN** a manager calls `POST /v1/alerts/:id/resolve`
- **THEN** the response is `403 FORBIDDEN`

#### Scenario: Two admins resolve at once
- **WHEN** two company admins resolve the same open event concurrently
- **THEN** both get the event, and `resolved_at` and `resolved_by` hold the first resolver's values

#### Scenario: One of two open events is resolved
- **WHEN** a device has two open tamper events and IT resolves one
- **THEN** the device still has the `open_alert` badge

### Requirement: An event is in the feed as soon as it is stored
<!-- source: PRD "Success metrics" -->
An event SHALL appear in `GET /v1/alerts` as soon as the request or job that stored it has committed, so a portal polling at most every 30 seconds shows it within 1 minute. Push delivery MUST NOT be required.

#### Scenario: A tamper report arrives
- **WHEN** `POST /v1/agents/tamper` returns `201`
- **THEN** the next `GET /v1/alerts` includes the event

### Requirement: Alerts never cross a company or reach staff
<!-- source: D41 · Plan-v3.5 §6.1 · B2 -->
`GET /v1/alerts` and `POST /v1/alerts/:id/resolve` SHALL read only the caller's company. A `super_admin` MUST get `403 FORBIDDEN`.

#### Scenario: Staff ask for alerts
- **WHEN** a super admin calls `GET /v1/alerts`
- **THEN** the response is `403 FORBIDDEN`

### Requirement: The feed is filtered per employee
<!-- source: Plan-v3.5 §4.5 "Employees" -->
`employee_id` SHALL limit the feed to events of devices bound to that employee, inside the caller's scope; for a manager, an employee outside the team MUST return an empty list.

#### Scenario: Alerts on the employee page
- **WHEN** a company admin lists alerts with `employee_id` of employee E
- **THEN** every item's `employee.id` is E and `counts` covers only E's events

### Requirement: Alerts name who resolved them and can be searched
<!-- source: Plan-v3.5 §4.5 "Alerts" -->
Each item SHALL carry `resolved_by_name` (the resolving user's name, `null` when none). `GET /v1/alerts` MUST accept `q`, at most 100 characters, matching case-insensitively and literally (no wildcards) any part of `event_type`, `hostname`, the employee's name or `detail`, combined with the other filters and applied to `counts`.

#### Scenario: Searching a laptop name
- **WHEN** a manager searches `q` = `mac-17`
- **THEN** only their team's events of devices whose hostname contains `mac-17` are listed

#### Scenario: Wildcard characters
- **WHEN** `q` is `%_`
- **THEN** only events containing the literal text `%_` are listed
