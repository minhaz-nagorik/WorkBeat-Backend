## Purpose

The staff view of every customer company — plan, seats, tier, status, domain and estimated
revenue — and the staff actions on a company: suspend, restore, Enterprise overrides and the
expired-licence grace period.

## ADDED Requirements

### Requirement: Staff list every company
<!-- source: Plan-v3.5 §4.6 · PRD "Permission matrix" · D41 -->
`GET /v1/staff/companies` SHALL return, to `super_admin` only, each company's `id`, `name`, `slug`, `plan`, `seat_limit`, `seats_used`, `screenshot_tier`, `status`, `suspended_reason`, `custom_domain`, `custom_domain_status`, `custom_domain_checked_at`, `key_last4`, `expired_blocking_grace_days`, `trial_ends_at`, `created_at` and `mrr_estimate` as `items`, with `totals` (`companies`, `seats_used`, `mrr_estimate`, `suspended`). It MUST filter by `status`, search `name`, `slug` or `key_last4` with `q`, and sort newest first. `GET /v1/staff/companies/:id` MUST return one row.

#### Scenario: Staff open the company list
- **WHEN** a `super_admin` calls `GET /v1/staff/companies?status=trial`
- **THEN** only `trial` companies are returned, each with `seats_used` and `seat_limit`

#### Scenario: A search with wildcard characters
- **WHEN** staff search for `acme_%`
- **THEN** only companies whose `name` or `slug` contains the literal text `acme_%` are returned

#### Scenario: An unknown company ID
- **WHEN** a `super_admin` calls `GET /v1/staff/companies/:id` with an ID of no company
- **THEN** the response is `404 NOT_FOUND`

### Requirement: Seats used come from a count-only function
<!-- source: D41 · B2 · B4 -->
`seats_used` on staff routes SHALL come from `company_seat_counts()`, which returns only `company_id` and the count of devices with `released_at` NULL. Staff routes MUST NOT read `devices` directly.

#### Scenario: A company with released devices
- **WHEN** a company has 12 devices of which 2 are released
- **THEN** its staff row shows `seats_used` 10

### Requirement: The MRR estimate follows the price list
<!-- source: PRD "Pricing" · Plan-v3.5 §4.6 -->
`mrr_estimate` SHALL be `seats_used` × ($1.00 + the tier add-on: `off` 0, `light` 0.50, `standard` 1.00, `intensive` 2.00) for an `active` company, and 0 for `trial`, `suspended` and `expired`. It MUST be labelled an estimate; invoices stay in Stripe.

#### Scenario: A Standard company
- **WHEN** an `active` company has 100 seats used on tier `standard`
- **THEN** its `mrr_estimate` is 200

#### Scenario: A company with no seats used
- **WHEN** an `active` company has 0 seats used on tier `intensive`
- **THEN** its `mrr_estimate` is 0

### Requirement: Staff suspend and restore a company
<!-- source: Plan-v3.5 §4.6 · PRD "Retention and suspension" · D29 -->
`POST /v1/staff/companies/:id/suspend` SHALL set `status` `suspended`, `suspended_reason` `staff` and `suspended_at`, also over a `payment_failed` suspension. `POST /v1/staff/companies/:id/restore` SHALL set `status` `active`, or `trial` while `trial_ends_at` is ahead, and clear `suspended_reason`. Either on an `expired` company MUST get `409 CONFLICT`.

#### Scenario: Staff suspend a company
- **WHEN** a `super_admin` suspends an active company
- **THEN** its `status` is `suspended` with `suspended_reason` `staff`
- **AND** a later `invoice.paid` leaves it suspended

#### Scenario: Restore an expired company
- **WHEN** a `super_admin` restores an `expired` company
- **THEN** the response is `409 CONFLICT` and nothing changes

#### Scenario: Suspended over a failed payment
- **WHEN** staff suspend a company already suspended for `payment_failed`
- **THEN** `suspended_reason` is `staff` and a later `invoice.paid` leaves it suspended

#### Scenario: Suspended twice
- **WHEN** staff suspend a company already suspended for `staff`
- **THEN** nothing changes and `suspended_at` keeps its first value

#### Scenario: A trial company is restored after its trial end
- **WHEN** staff restore a suspended company whose `trial_ends_at` has passed
- **THEN** its `status` is `active`

#### Scenario: Restore a company that is not suspended
- **WHEN** staff restore an `active` company
- **THEN** the company is returned unchanged

#### Scenario: Staff suspend while invoice.paid is handled
- **WHEN** a staff suspension and an `invoice.paid` for the same company are handled concurrently
- **THEN** the company ends `suspended` with `suspended_reason` `staff`

### Requirement: Staff set the plan, seat limit and screenshot tier
<!-- source: Plan-v3.5 §4.6 · PRD "Pricing" · B4 · B30 -->
`PATCH /v1/staff/companies/:id/license` SHALL accept `plan` (`starter`, `growth`, `enterprise`), `seat_limit` (a number, or NULL for unlimited) and `screenshot_tier`, each optional, at least one; left-out fields keep their values. NULL seats on a non-Enterprise plan MUST get `422 VALIDATION_FAILED`; a `seat_limit` below seats used MUST get `409 CONFLICT`; both change nothing.

#### Scenario: A limit below seats used
- **WHEN** an Enterprise company uses 412 seats and staff set `seat_limit` 400
- **THEN** the response is `409 CONFLICT` and `seat_limit` is unchanged

#### Scenario: A limit equal to seats used
- **WHEN** an Enterprise company uses 400 seats and staff set `seat_limit` 400
- **THEN** the limit is saved and the next enrollment answers `403 SEAT_LIMIT_EXCEEDED`

#### Scenario: A Growth licence
- **WHEN** staff patch `seat_limit` 80 on a `growth` licence using 50 seats
- **THEN** the licence keeps `growth` with `seat_limit` 80

#### Scenario: Unlimited seats on Growth
- **WHEN** staff patch `{ "plan": "growth", "seat_limit": null }`
- **THEN** the response is `422 VALIDATION_FAILED` and the licence is unchanged

### Requirement: A screenshot tier change reaches every device
<!-- source: B30 · B11 -->
A changed `screenshot_tier` SHALL raise the company's `policy_version`. Employees' stored intervals MUST NOT be written; the agent policy caps them at the tier (`serve-agent-policy`).

#### Scenario: Intensive down to light
- **WHEN** staff change the tier from `intensive` to `light` for a company whose employee has 600
- **THEN** `policy_version` rises and that employee's policy carries 3600 while the stored value stays 600

#### Scenario: Unlimited
- **WHEN** staff set `seat_limit` null on an Enterprise licence
- **THEN** enrollments are never refused for seats

### Requirement: Staff set the expired-licence grace period
<!-- source: D36 · Plan-v3.5 §4.6 -->
`PATCH /v1/staff/companies/:id` with `expired_blocking_grace_days` (0–365) SHALL update the company; other values MUST get `422 VALIDATION_FAILED`. The new value MUST apply at once to `blocking_ends_at` (`company-status`).

#### Scenario: Staff extend the grace
- **WHEN** staff set `expired_blocking_grace_days` to 60 for a company that expired 40 days ago
- **THEN** its `blocking_ends_at` is 20 days ahead

#### Scenario: The boundaries
- **WHEN** staff set `expired_blocking_grace_days` to 0, 365 and then 366
- **THEN** 0 and 365 are saved and 366 gets `422 VALIDATION_FAILED`

#### Scenario: The grace is shortened into the past
- **WHEN** staff set 10 days for a company that expired 40 days ago
- **THEN** its `blocking_ends_at` is 30 days in the past

### Requirement: Staff set the company name and retention
<!-- source: B29 · B13 -->
`PATCH /v1/staff/companies/:id` SHALL also accept `name` (1–100 characters) and `data_retention_days` (30, 60 or 90), each optional; fields left out MUST keep their values. The company row in responses MUST carry `data_retention_days`. Other values MUST get `422 VALIDATION_FAILED`.

#### Scenario: Staff lower retention
- **WHEN** staff patch `{ "data_retention_days": 60 }`
- **THEN** the response is `200` with `data_retention_days` 60 and the same `name` and grace

#### Scenario: Retention 45
- **WHEN** staff patch `{ "data_retention_days": 45 }`
- **THEN** the response is `422 VALIDATION_FAILED` and nothing changes

### Requirement: Staff set the company status
<!-- source: B30 · D29 · D36 -->
`PATCH /v1/staff/companies/:id` SHALL accept `status` (`trial`, `active`, `suspended`, `expired`) and `trial_days` (1–90). `suspended` MUST keep an existing reason, else set `staff`, and `suspended_at`. Any other status clears the suspension. `expired` MUST set `licenses.expired_at` if unset; any other status clears it. `trial` MUST set `trial_ends_at` to now + `trial_days`, and without `trial_days` and a future `trial_ends_at` MUST get `422 VALIDATION_FAILED`.

#### Scenario: Staff expire a company
- **WHEN** staff patch `{ "status": "expired" }` on an active company
- **THEN** its `status` is `expired`, `expired_at` is now and agents get `402 LICENSE_EXPIRED`

#### Scenario: Back to active
- **WHEN** staff patch `{ "status": "active" }` on an expired company
- **THEN** its `status` is `active` and `expired_at` is NULL

#### Scenario: A trial without days
- **WHEN** staff patch `{ "status": "trial" }` for a company whose `trial_ends_at` has passed
- **THEN** the response is `422 VALIDATION_FAILED` naming `trial_days` and nothing changes

### Requirement: Staff end a trial early
<!-- source: B30 -->
Setting `status` `active` or `expired` on a company with a running trial SHALL end the trial: `trial_ends_at` MUST become now, so a later restore MUST NOT bring the trial back.

#### Scenario: Staff end a trial early
- **WHEN** staff patch `{ "status": "active" }` on a company whose trial ends in 10 days
- **THEN** its `status` is `active` with `trial_ends_at` now, and a later suspend and restore leaves it `active`

### Requirement: Staff routes answer 404 for unknown IDs
<!-- source: D41 · role-access -->
Every `/v1/staff/*` route with an ID in the path SHALL answer `404 NOT_FOUND`, and change nothing, when the ID names no row of the kind the route acts on, including a company user's ID on a staff-user route.

#### Scenario: An unknown release
- **WHEN** staff withdraw a release ID that does not exist
- **THEN** the response is `404 NOT_FOUND`

### Requirement: Staff move any licence to Enterprise
<!-- source: Plan-v3.5 §4.6 · PRD "Pricing" -->
`PATCH /v1/staff/companies/:id/license` with `plan` `enterprise` SHALL also apply to a `starter` or `growth` licence, setting `plan` `enterprise` and the given `seat_limit`.

#### Scenario: A Growth company moves to Enterprise
- **WHEN** staff patch a `growth` licence with `plan` `enterprise` and `seat_limit` 500
- **THEN** the licence has plan `enterprise` and `seat_limit` 500

### Requirement: Staff create a company with its first admin
<!-- source: product owner 17 Nov 2026 · D41 -->
`POST /v1/staff/companies` SHALL be allowed to `super_admin` only. In one transaction it MUST insert the `companies` row, its `licenses` row with a new key, the default sensitive domains and a `company_admin` invitation for `admin_email` with `invited_by` = the caller. It MUST answer `201 { company, invitation: { email, expires_at } }` and never the key or the invitation token.

#### Scenario: Staff create a trial company
- **WHEN** a super admin posts a valid body with `status` `trial` and `trial_days` 14
- **THEN** the response is `201`, `company.status` is `trial`, `trial_ends_at` is 14 days ahead and the body holds no licence key

### Requirement: A new company's admin gets the key and the link by email
<!-- source: product owner 17 Nov 2026 · B6 -->
After the company is created, the API SHALL send one email to `admin_email` with the company name, the licence key and the link `PORTAL_URL/invite?token=…`. Neither the key nor the token MUST be logged.

#### Scenario: The admin accepts
- **WHEN** the admin opens the link and accepts with a name and password
- **THEN** they are a `company_admin` of the new company with a session

### Requirement: Company creation refuses clashes and bad values
<!-- source: product owner 17 Nov 2026 -->
A taken `slug` MUST get `409 CONFLICT` with `fields` `["slug"]`; an `admin_email` of any `users` row or open invitation MUST get `409 CONFLICT` with `fields` `["admin_email"]`. A `null` `seat_limit` without `enterprise`, a `trial` without `trial_days` (1–90), an unknown `timezone` or any other bad value MUST get `422 VALIDATION_FAILED` naming each field.

#### Scenario: Unlimited seats on Starter
- **WHEN** a super admin posts `plan` `starter` with `seat_limit` `null`
- **THEN** the response is `422` with `fields` `["seat_limit"]` and no company is created

### Requirement: Staff list Company Admins across companies
<!-- source: product owner 17 Nov 2026 · D41 -->
`GET /v1/staff/company-admins` SHALL return to `super_admin` only the enabled `company_admin` users, newest first, as `{ id, name, email, company: { id, name, slug }, created_at, must_change_password }`, filtered by `q` (literal, case-insensitive on name, email, company name or slug) and `company_id`. No other role's user MUST appear.

#### Scenario: Search by company slug
- **WHEN** a super admin calls it with `q` equal to a company's slug
- **THEN** only that company's enabled company admins are returned
