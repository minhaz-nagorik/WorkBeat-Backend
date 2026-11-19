## Purpose

The company-wide settings: the idle threshold, timezone and alert email recipients a company admin
edits, the name and retention WorkBeat staff set (B29), and the onboarding checklist that tracks the
first install.

## ADDED Requirements

### Requirement: A company admin reads and edits company settings
<!-- source: Plan-v3.5 §4.5 "Settings" · PRD "Permission matrix" · B29 -->
`GET /v1/company/settings` and `PATCH /v1/company/settings` SHALL be allowed to `company_admin` only. `GET` returns `name`, `slug`, `data_retention_days`, `idle_threshold_seconds`, `alert_email` and `timezone`. `PATCH` MUST write only `idle_threshold_seconds`, `alert_email` and `timezone`. Other roles MUST get `403 FORBIDDEN`.

#### Scenario: An IT admin edits settings
- **WHEN** an `it_admin` calls `PATCH /v1/company/settings`
- **THEN** the response is `403 FORBIDDEN`

#### Scenario: A slug in the body
- **WHEN** a company admin patches `{ "slug": "new-slug", "timezone": "UTC" }`
- **THEN** `slug` is unchanged

### Requirement: Name and retention are set by WorkBeat staff
<!-- source: B29 -->
A `PATCH /v1/company/settings` body holding `name` or `data_retention_days` SHALL get `403 FORBIDDEN` naming them in `fields`, and MUST change nothing, not even its other fields. Staff set both with `PATCH /v1/staff/companies/:id` (`staff-companies`): `name` 1–100 characters.

#### Scenario: An admin renames the company
- **WHEN** a company admin patches `{ "name": "Acme Group", "timezone": "UTC" }`
- **THEN** the response is `403 FORBIDDEN` with `fields` `["name"]`
- **AND** neither the name nor the timezone changes

#### Scenario: Staff rename the company
- **WHEN** staff patch `{ "name": "Acme Group" }` on the company
- **THEN** the response is `200` with `name` `Acme Group` and the same `slug`

#### Scenario: Name length boundaries
- **WHEN** staff set `name` to 100 characters, then to 101 characters or only spaces
- **THEN** the 100-character name is saved and the others get `422 VALIDATION_FAILED`

### Requirement: Retention is 30, 60 or 90 days
<!-- source: B13 · B29 · PRD "Retention and suspension" -->
`data_retention_days`, set by staff, SHALL accept only 30, 60 or 90, default 90, and MUST refuse any other value with `422 VALIDATION_FAILED`. Data older than the new value is removed by the next retention run (`run-scheduled-jobs`, `data-retention`), not by this route.

#### Scenario: Retention over the maximum
- **WHEN** staff set `data_retention_days` to 180 or 365
- **THEN** the response is `422 VALIDATION_FAILED` naming `data_retention_days`

#### Scenario: The three choices
- **WHEN** staff set `data_retention_days` to 30, 60, 90, 45, 0 and 30.5
- **THEN** 30, 60 and 90 are saved and 45, 0 and 30.5 get `422 VALIDATION_FAILED`

#### Scenario: Retention lowered from 90 to 30
- **WHEN** staff lower `data_retention_days` from 90 to 30
- **THEN** the response is `200` at once and no activity row is deleted by the request

### Requirement: The idle threshold reaches every device
<!-- source: Plan-v3.5 §4.4 "Policy versioning" · agent-contract.md "Policy response" -->
`idle_threshold_seconds` SHALL accept 60 to 3600 and MUST refuse other values with `422 VALIDATION_FAILED`. A change MUST raise the company's `policy_version` so devices fetch it (`serve-agent-policy`).

#### Scenario: The threshold changes
- **WHEN** a company admin sets `idle_threshold_seconds` to 600
- **THEN** `companies.policy_version` is greater than before

#### Scenario: The boundaries
- **WHEN** a company admin sets `idle_threshold_seconds` to 60, 3600, 59 and 3601
- **THEN** 60 and 3600 are saved and 59 and 3601 get `422 VALIDATION_FAILED`

#### Scenario: The same value again
- **WHEN** a company admin patches `idle_threshold_seconds` with its current value
- **THEN** `companies.policy_version` is unchanged

### Requirement: Alert email recipients are configurable
<!-- source: Plan-v3.5 §4.4 "Tamper event processing" · data-model.md "companies" -->
`alert_email` SHALL be `{ roles, types, delivery }` where `roles` is a non-empty subset of `company_admin`, `manager` and `it_admin`, `types` a subset of the tamper `event_type` values including `offline`, and `delivery` one of `instant`, `hourly`, `daily`. Any other value MUST get `422 VALIDATION_FAILED`.

#### Scenario: Daily digest for IT
- **WHEN** a company admin sets `{ "roles": ["it_admin"], "types": ["offline"], "delivery": "daily" }`
- **THEN** the stored `alert_email` equals it

#### Scenario: Nobody is to be emailed
- **WHEN** a company admin sets `roles` to `[]`
- **THEN** the response is `422 VALIDATION_FAILED` with `fields` `["alert_email.roles"]` and the stored value is unchanged

#### Scenario: Staff as a recipient role
- **WHEN** a company admin sets `roles` to `["super_admin"]`
- **THEN** the response is `422 VALIDATION_FAILED`

### Requirement: The setup checklist tracks the first install
<!-- source: Plan-v3.5 §4.5 "Onboarding" -->
`GET /v1/company/setup` SHALL return, to `company_admin` and `it_admin`, the steps `download_downloader`, `copy_license_key`, `install_first_device` and `first_device_seen` with `done` for each. The first two MUST come from `setup_completed_steps`, marked by `POST /v1/company/setup/steps` with `step`; `install_first_device` MUST be true once the company has a device row and `first_device_seen` once one has `last_heartbeat_at`.

#### Scenario: IT marks the download step
- **WHEN** an `it_admin` posts `{ "step": "download_downloader" }`
- **THEN** `setup_completed_steps` contains `download_downloader`

#### Scenario: The first heartbeat arrives
- **WHEN** a company's first device has sent a heartbeat
- **THEN** `first_device_seen` is `done` true

#### Scenario: A step marked twice
- **WHEN** an `it_admin` posts `download_downloader` twice
- **THEN** `setup_completed_steps` holds it once

#### Scenario: An unknown or derived step
- **WHEN** a request posts `step` `first_device_seen` or `foo`
- **THEN** the response is `422 VALIDATION_FAILED`

#### Scenario: The first device was released
- **WHEN** the company's only device was released
- **THEN** `install_first_device` and `first_device_seen` stay `done` true

### Requirement: The company sets its timezone
<!-- source: B19 · PRD "Activity levels, productivity, calendar and timesheets" -->
`PATCH /v1/company/settings` SHALL accept `timezone`, an IANA name, from a `company_admin`, and MUST refuse an unknown name with `422 VALIDATION_FAILED`. The default is `UTC`. Reports, calendars, timesheets, the screenshot day and daily alert digests MUST use it.

#### Scenario: A Dhaka company sets its zone
- **WHEN** a `company_admin` sets `timezone` to `Asia/Dhaka`
- **THEN** a day in its calendar runs from 00:00 to 24:00 Dhaka time

#### Scenario: The zone is changed
- **WHEN** a company admin changes `timezone` from `UTC` to `Asia/Dhaka`
- **THEN** every later report, including past days, uses Dhaka days, and no stored row changes

#### Scenario: A daylight-saving zone
- **WHEN** `timezone` is `Europe/London` and the clocks go forward
- **THEN** that day in its calendar is 23 hours long
