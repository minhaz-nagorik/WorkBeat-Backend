## Purpose

The four states a company can be in, who moves it between them, the `blocking_ends_at` an
expired company's agents count down to, and the codes the agent routes answer in each state.

## ADDED Requirements

### Requirement: A company has one of four statuses
<!-- source: B14 · D29 · D30 · data-model.md "companies" -->
`companies.status` SHALL be `trial`, `active`, `suspended` or `expired`, and `suspended_reason` (`payment_failed` or `staff`) MUST be set exactly when `status` is `suspended`. Only `subscription-sync` and the staff suspend and restore routes (`staff-companies`) SHALL change `status`; no company route MUST change it.

#### Scenario: A company admin tries to un-suspend
- **WHEN** a company admin sends `status` `active` to any company route
- **THEN** the field is ignored and `status` is unchanged

#### Scenario: A company admin sends a status in a settings request
- **WHEN** a company admin patches company settings with `status` `active` and `suspended_reason` NULL
- **THEN** both fields are ignored and the company stays `suspended`

### Requirement: Trial and active companies are served
<!-- source: B14 · Plan-v3.5 §4.4 -->
A company in `trial` or `active` SHALL be served on every agent and Downloader route without a status code, subject only to seats and credentials.

#### Scenario: A trial company enrolls a device
- **WHEN** a `trial` company with a free seat validates its licence key
- **THEN** validation is not refused for status

### Requirement: Suspended and expired companies get 402 codes
<!-- source: D29 · D30 · D36 · agent-contract.md "Status and code catalog" -->
For a `suspended` company, agent routes SHALL answer `402 COMPANY_SUSPENDED`, and `/license/validate` and enrollment `402 LICENSE_SUSPENDED`. For an `expired` company, all of them SHALL answer `402 LICENSE_EXPIRED` with `blocking_ends_at`. Which routes check and when is specified by `enroll-devices` (`device-authentication`, `license-validation`, `device-enrollment`).

#### Scenario: A heartbeat from a suspended company
- **WHEN** a device of a `suspended` company sends a heartbeat
- **THEN** the answer is `402` with `code` `COMPANY_SUSPENDED`

#### Scenario: A heartbeat from an expired company
- **WHEN** a device of an `expired` company sends a heartbeat
- **THEN** the answer is `402` with `code` `LICENSE_EXPIRED` and a `blocking_ends_at`

#### Scenario: A staff-suspended company
- **WHEN** a device of a company with `suspended_reason` `staff` sends a heartbeat
- **THEN** the answer is `402` with `code` `COMPANY_SUSPENDED`, the same as for `payment_failed`

#### Scenario: Past blocking_ends_at
- **WHEN** a device of a company whose `blocking_ends_at` passed yesterday sends a heartbeat
- **THEN** the answer is still `402` with `code` `LICENSE_EXPIRED` and that past `blocking_ends_at`

### Requirement: blocking_ends_at is computed from the expiry and grace days
<!-- source: D36 · D30 -->
`blocking_ends_at` SHALL be `licenses.expired_at` plus `companies.expired_blocking_grace_days` days, computed on every read and never stored, so a change to the grace days applies at once to an already-expired company.

#### Scenario: The default grace
- **WHEN** a licence expired at 2026-12-01T00:00:00Z with the default 30 grace days
- **THEN** `blocking_ends_at` is 2026-12-31T00:00:00Z

#### Scenario: Zero grace days
- **WHEN** `expired_blocking_grace_days` is 0
- **THEN** `blocking_ends_at` equals `licenses.expired_at`

#### Scenario: A company that is not expired
- **WHEN** the company's `status` is `active`, `trial` or `suspended`
- **THEN** `blocking_ends_at` is `null`

### Requirement: Company users can read their status
<!-- source: Plan-v3.5 §4.5 · D29 -->
`GET /v1/company/status` SHALL return, to every company role, `status`, `suspended_reason`, `trial_ends_at`, `expired_at` and `blocking_ends_at` for the caller's company. Every portal read and write MUST keep working while the company is `suspended` or `expired`: only agent and Downloader routes answer the `402` codes.

#### Scenario: A suspended company signs in
- **WHEN** a company admin of a company suspended for `payment_failed` calls `GET /v1/company/status`
- **THEN** the response is `200` with `status` `suspended` and `suspended_reason` `payment_failed`

#### Scenario: A company ID in the query
- **WHEN** a company A admin calls `GET /v1/company/status?company_id=<B>`
- **THEN** the response describes company A only

#### Scenario: A manager reads the status of an expired company
- **WHEN** a manager of an `expired` company calls `GET /v1/company/status`
- **THEN** the response is `200` with `status` `expired`, `expired_at` and `blocking_ends_at`

### Requirement: Portal writes are not refused for billing
<!-- source: D5 · D29 · D38 -->
No portal route SHALL answer `402` or refuse a write because the company is `suspended` or `expired`, so admins can still release devices, edit employees and rules, and fix billing.

#### Scenario: Releasing a laptop while suspended
- **WHEN** an IT admin of a suspended company releases a device
- **THEN** the response is `200` and the device is released
