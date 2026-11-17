## Purpose

How an IT Admin's write waits for a Company Admin: it is checked and stored, not applied, and a
Company Admin approves, rejects or sees it fail; the IT Admin may cancel it while it waits.

## ADDED Requirements

### Requirement: An IT Admin's write becomes a pending change
<!-- source: product owner 17 Nov 2026 · Plan-v3.5 §4.5 -->
On the employee, import, monitoring-settings, pause, device release and deactivate, alert resolve, block-rule, sensitive-domain and productivity-rule write routes, an `it_admin` request SHALL be validated exactly as a `company_admin`'s, including `404` and `409`, then rolled back and stored in `changes`. It MUST answer `202 { change }` with `status` `pending` and MUST NOT apply anything.

#### Scenario: An IT Admin blocks a website
- **WHEN** an `it_admin` posts a valid domain block rule
- **THEN** the response is `202` with `change.status` `pending` and `block_rules` is unchanged

#### Scenario: An invalid request
- **WHEN** an `it_admin` posts a block rule with a scheme
- **THEN** the response is `422 VALIDATION_FAILED` and no change is stored

### Requirement: The change object describes the request for people
<!-- source: product owner 17 Nov 2026 -->
A change SHALL carry `id`, `status` (pending, approved, rejected, cancelled, failed), `resource`, `action`, `target_id`, a plain-language `summary` with no enum value or ID, `requested_by` `{ id, name }`, `requested_at`, `decided_by`, `decided_at`, `reason` and `error` `{ code, message }` when failed.

#### Scenario: A release request
- **WHEN** an `it_admin` asks to release computer `NG-LT-0141`
- **THEN** the change has `resource` `device`, `action` `release` and `summary` `Release computer NG-LT-0141`

### Requirement: Company Admins list and decide changes
<!-- source: product owner 17 Nov 2026 -->
`GET /v1/changes` SHALL return, newest first and at most 500, every change of the company to a `company_admin` and only their own to an `it_admin`, filtered by `status` and `resource`; a `manager` MUST get `403`. `POST /v1/changes/:id/reject` with an optional `reason` (≤ 500) MUST set `rejected`. Deciding a change that is not `pending` MUST get `409 CONFLICT`.

#### Scenario: Rejecting twice
- **WHEN** a company admin rejects a change and then approves it
- **THEN** the second call is `409 CONFLICT`

### Requirement: Approval applies the stored request as the approver
<!-- source: product owner 17 Nov 2026 -->
`POST /v1/changes/:id/approve` SHALL replay the stored request as the approving `company_admin`, so the record it writes names that admin. On success the change MUST become `approved`; when the request no longer applies it MUST become `failed` with the API error's `code` and `message`.

#### Scenario: The employee was added meanwhile
- **WHEN** a company admin approves an IT Admin's "add employee" after adding the same email directly
- **THEN** the change is `failed` with `error.code` `CONFLICT`

### Requirement: The requester may cancel a pending change
<!-- source: product owner 17 Nov 2026 -->
`DELETE /v1/changes/:id` SHALL be allowed only to the `it_admin` who asked, while it is `pending`, and MUST set `cancelled` and answer `204`. Another user's change MUST get `404 NOT_FOUND`, a decided one `409 CONFLICT`. A pending change of a removed IT Admin MUST stay decidable.

#### Scenario: Cancelling twice
- **WHEN** an IT Admin cancels their change twice
- **THEN** the second call is `409 CONFLICT`

### Requirement: Changes are announced by email
<!-- source: product owner 17 Nov 2026 -->
A new pending change SHALL email every enabled `company_admin`, at most once per 15 minutes per company. An approved, rejected or failed change MUST email the requester while they are enabled.

#### Scenario: Two changes in a minute
- **WHEN** an IT Admin makes two changes one minute apart
- **THEN** the company admins get one email
