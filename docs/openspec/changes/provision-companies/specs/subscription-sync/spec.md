## Purpose

How Stripe subscription events keep each company's plan, seats, screenshot tier and status in
step with billing, and the billing routes a company admin uses to change them.

## ADDED Requirements

### Requirement: Subscription events set plan, seats and period
<!-- source: Plan-v3.5 §4.4 "Plan changes" · PRD "Pricing" -->
On `customer.subscription.updated`, the API SHALL find the company through `company_by_stripe_customer`, read the subscription as Stripe returns it at that moment, and set `licenses.plan`, `seat_limit` from the plan (10 or 50; for `enterprise`, unchanged from the staff-set value), `screenshot_tier` from its add-on item, and `current_period_end`. A `trial` company whose subscription turns `active` MUST become `active`.

#### Scenario: An upgrade to Growth
- **WHEN** a Starter subscription changes to the Growth price
- **THEN** the licence has `plan` `growth` and `seat_limit` 50

#### Scenario: A trial converts
- **WHEN** a `trial` company's subscription becomes `active`
- **THEN** the company's `status` is `active`

#### Scenario: Events arrive out of order
- **WHEN** an older `customer.subscription.updated` (Starter) is delivered after a newer one (Growth)
- **THEN** the licence matches the subscription Stripe returns when each is handled, so it ends on `growth`

#### Scenario: An event for an unknown customer
- **WHEN** a `customer.subscription.updated` names a Stripe customer with no company
- **THEN** the response is `200`, the event is marked processed and no row changes

#### Scenario: An Enterprise subscription changes period
- **WHEN** an Enterprise subscription with a staff-set `seat_limit` of 400 renews
- **THEN** `seat_limit` stays 400 and `current_period_end` moves

### Requirement: A lower tier lowers every employee's interval
<!-- source: B11 · D37 · PRD "Pricing" -->
When `screenshot_tier` changes to a less frequent tier, every `employee_monitoring_settings` row of the company whose `screenshot_interval_seconds` is above 0 and below the new tier's interval SHALL be set to that interval in the same transaction. Tier `off` MUST set every row to 0. A higher tier MUST leave the rows unchanged.

#### Scenario: Standard down to Light
- **WHEN** the tier changes from `standard` to `light`
- **THEN** employees at 600 or 1800 seconds are set to 3600
- **AND** employees at 0 stay at 0

#### Scenario: Screenshots switched off
- **WHEN** the tier changes to `off`
- **THEN** every employee's `screenshot_interval_seconds` is 0

#### Scenario: The same tier event is replayed
- **WHEN** a second subscription event repeats tier `light` for a company already on `light`
- **THEN** no `employee_monitoring_settings` row changes and no `policy_version` rises

#### Scenario: Intensive straight to off
- **WHEN** the tier changes from `intensive` to `off`
- **THEN** employees at 600, 1800 and 3600 are all set to 0 in one transaction

### Requirement: A failed renewal suspends at once
<!-- source: D29 · PRD "Retention and suspension" -->
On `invoice.payment_failed` for a renewal, the API SHALL set the company's `status` `suspended`, `suspended_reason` `payment_failed` and `suspended_at`, with no grace period. On `invoice.paid`, a company suspended for `payment_failed` MUST return to `active`; a company suspended for `staff` MUST stay suspended.

#### Scenario: A card is declined
- **WHEN** Stripe sends `invoice.payment_failed` for the renewal of an active company
- **THEN** its `status` is `suspended` with `suspended_reason` `payment_failed` immediately

#### Scenario: The payment succeeds later
- **WHEN** Stripe sends `invoice.paid` for that company
- **THEN** its `status` is `active` and `suspended_reason` is NULL

#### Scenario: Paid seconds after failed
- **WHEN** `invoice.payment_failed` and then `invoice.paid` for the same invoice arrive two seconds apart
- **THEN** the company is `active` with `suspended_reason` NULL

#### Scenario: Paid is delivered before failed
- **WHEN** `invoice.paid` is handled and the earlier `invoice.payment_failed` for that invoice arrives afterwards
- **THEN** the invoice Stripe returns is `paid`, so the company is not suspended

#### Scenario: A payment fails during a staff suspension
- **WHEN** a company suspended for `staff` receives `invoice.payment_failed`
- **THEN** `suspended_reason` stays `staff`

#### Scenario: An expired company receives an invoice event
- **WHEN** an `expired` company receives `invoice.paid` or `invoice.payment_failed`
- **THEN** its `status` stays `expired`

### Requirement: An ended subscription expires the licence
<!-- source: D30 · D36 · Plan-v3.5 §4.4 "Expired licence" -->
On `customer.subscription.deleted`, the API SHALL set the company's `status` `expired`, clear `suspended_reason`, and set `licenses.expired_at` to the event time. Device rows and their seats MUST be left unchanged.

#### Scenario: A customer cancels
- **WHEN** a company's subscription is deleted
- **THEN** its `status` is `expired` and `licenses.expired_at` is set
- **AND** its devices are unchanged

#### Scenario: Deleted while suspended for a failed payment
- **WHEN** a company suspended for `payment_failed` has its subscription deleted
- **THEN** its `status` is `expired` and `suspended_reason` is NULL

#### Scenario: The deletion is delivered twice under two event IDs
- **WHEN** a second `customer.subscription.deleted` for an already `expired` company arrives
- **THEN** `licenses.expired_at` keeps its first value

### Requirement: No company role reaches billing
<!-- source: B29 -->
`GET /v1/billing`, `PUT /v1/billing/screenshot-tier` and `POST /v1/billing/portal-session` SHALL answer `403 FORBIDDEN` to every company role, `company_admin` included. WorkBeat staff handle billing.

#### Scenario: A company admin opens billing
- **WHEN** a `company_admin` calls `GET /v1/billing`
- **THEN** the response is `403` with `code` `FORBIDDEN`

### Requirement: Billing reads and changes
<!-- source: Plan-v3.5 §4.5 "Settings" · PRD "Pricing" -->
When allowed, `GET /v1/billing` SHALL return `plan`, `seat_limit`, `seats_used`, `screenshot_tier`, any scheduled tier with its date, `trial_ends_at` and `current_period_end`. `PUT /v1/billing/screenshot-tier` MUST schedule the change in Stripe for `current_period_end` and MUST NOT change `licenses.screenshot_tier`; `POST /v1/billing/portal-session` MUST return a Stripe billing portal URL.

#### Scenario: A higher tier is picked
- **WHEN** tier `intensive` is put
- **THEN** the response shows `intensive` scheduled for `current_period_end`
- **AND** `licenses.screenshot_tier` is unchanged until the subscription event at that date

#### Scenario: A scheduled downgrade is cancelled
- **WHEN** tier `light` is scheduled from `standard` and then `standard` is put before `current_period_end`
- **THEN** Stripe holds no scheduled change and `GET /v1/billing` shows no scheduled tier
- **AND** no employee interval changes

#### Scenario: An IT admin opens billing
- **WHEN** an `it_admin` calls `GET /v1/billing`
- **THEN** the response is `403` with `code` `FORBIDDEN`

#### Scenario: Billing while suspended
- **WHEN** a portal session is asked for a company suspended for `payment_failed`
- **THEN** the response is `200` with a portal URL

### Requirement: A lower seat limit never removes devices
<!-- source: D43 · B4 · PRD "Pricing" -->
When a subscription event sets a `seat_limit` below the company's seats used, the API SHALL store the new limit and MUST NOT release or refuse any already enrolled device. Further enrollments MUST answer `403 SEAT_LIMIT_EXCEEDED` until seats used falls below the limit (`enroll-devices`).

#### Scenario: Growth down to Starter with 30 devices
- **WHEN** a Growth company with 30 enrolled devices changes to the Starter price
- **THEN** `seat_limit` is 10, all 30 devices keep working
- **AND** a new enrollment answers `403` with `code` `SEAT_LIMIT_EXCEEDED`

#### Scenario: Seats freed below the new limit
- **WHEN** that company releases 21 devices
- **THEN** `seats_used` is 9 and the next enrollment succeeds
