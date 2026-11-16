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
`seats_used` on staff routes SHALL come from `company_seat_counts()`, which returns only `company_id` and the count of devices with `deactivated_at` and `released_at` NULL. Staff routes MUST NOT read `devices` directly.

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

### Requirement: Staff override Enterprise plan and seat limit
<!-- source: Plan-v3.5 §4.6 · PRD "Pricing" · B4 -->
`PATCH /v1/staff/companies/:id/license` with `plan` `enterprise` and `seat_limit` (a number or NULL for unlimited) SHALL update the licence. A `seat_limit` below the company's seats used, or a `seat_limit` change on a `starter` or `growth` licence, MUST get `409 CONFLICT` and change nothing.

#### Scenario: A limit below seats used
- **WHEN** an Enterprise company uses 412 seats and staff set `seat_limit` 400
- **THEN** the response is `409 CONFLICT` and `seat_limit` is unchanged

#### Scenario: A limit equal to seats used
- **WHEN** an Enterprise company uses 400 seats and staff set `seat_limit` 400
- **THEN** the limit is saved and the next enrollment answers `403 SEAT_LIMIT_EXCEEDED`

#### Scenario: A Growth licence
- **WHEN** staff patch `seat_limit` 80 on a `growth` licence
- **THEN** the response is `409 CONFLICT` and `seat_limit` stays 50

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

### Requirement: Staff routes answer 404 for unknown IDs
<!-- source: D41 · role-access -->
Every `/v1/staff/*` route with an ID in the path SHALL answer `404 NOT_FOUND`, and change nothing, when the ID names no row of the kind the route acts on, including a company user's ID on a staff-user route.

#### Scenario: An unknown release
- **WHEN** staff withdraw a release ID that does not exist
- **THEN** the response is `404 NOT_FOUND`

### Requirement: Staff move any licence to Enterprise
<!-- source: Plan-v3.5 §4.6 · PRD "Pricing" -->
`PATCH /v1/staff/companies/:id/license` with `plan` `enterprise` SHALL also apply to a `starter` or `growth` licence, setting `plan` `enterprise` and the given `seat_limit`; only a `seat_limit` change that keeps a `starter` or `growth` plan MUST get `409 CONFLICT`.

#### Scenario: A Growth company moves to Enterprise
- **WHEN** staff patch a `growth` licence with `plan` `enterprise` and `seat_limit` 500
- **THEN** the licence has plan `enterprise` and `seat_limit` 500
