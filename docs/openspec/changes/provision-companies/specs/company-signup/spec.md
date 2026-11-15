## Purpose

How a Stripe checkout becomes a WorkBeat company: the webhook route, everything created for the
company in one step, its first company admin and the welcome email with the licence key.

## ADDED Requirements

### Requirement: Stripe webhooks are verified and processed once
<!-- source: Plan-v3.2 §4.4 "Company, subscription and licence" · PRD "API surface" -->
`POST /v1/webhooks/stripe` SHALL verify the `Stripe-Signature` header against the raw body before parsing; a bad or missing signature MUST get `400 WEBHOOK_SIGNATURE_INVALID` and store nothing. Each event SHALL be inserted into `stripe_events` by its `id`; an `id` already processed MUST answer `200` without running its handler again.

#### Scenario: Stripe retries an event
- **WHEN** the same `checkout.session.completed` event is delivered twice
- **THEN** both deliveries get `200`
- **AND** exactly one company exists for it

#### Scenario: A forged webhook
- **WHEN** a request to `/v1/webhooks/stripe` carries an invalid signature
- **THEN** the response is `400` with `code` `WEBHOOK_SIGNATURE_INVALID`
- **AND** no `stripe_events` row is written

#### Scenario: Two deliveries of one event arrive at the same moment
- **WHEN** Stripe delivers the same event `id` twice concurrently
- **THEN** the second delivery waits on the first's `stripe_events` row and then answers `200`
- **AND** the handler's writes exist exactly once

#### Scenario: A replay of an event processed last week
- **WHEN** an event whose `stripe_events.processed_at` was set seven days ago is delivered again
- **THEN** the response is `200` and no company, licence or status changes

#### Scenario: A signature over a modified body
- **WHEN** the `Stripe-Signature` is valid for a body that was then altered by one byte
- **THEN** the response is `400` with `code` `WEBHOOK_SIGNATURE_INVALID`

### Requirement: A completed checkout creates the company
<!-- source: PRD "Purchase, license and install", "Pricing" · B14 -->
On `checkout.session.completed`, the API SHALL insert a `companies` row with the checkout's company name and a `slug` made from it (lowercase, hyphens, at most 32 characters, a numeric suffix when taken) and a `licenses` row with the price's `plan`, `seat_limit` 10 for `starter`, 50 for `growth`, NULL for `enterprise`, `screenshot_tier` `off`, and the Stripe customer and subscription IDs.

#### Scenario: A Growth checkout
- **WHEN** a checkout for the Growth price completes for "Acme Ltd"
- **THEN** a company with `slug` `acme-ltd` and `status` `active` exists
- **AND** its licence has `plan` `growth`, `seat_limit` 50 and `screenshot_tier` `off`

#### Scenario: The slug is taken
- **WHEN** another company already has `slug` `acme-ltd`
- **THEN** the new company gets `acme-ltd-2`

#### Scenario: Two checkouts complete for one Stripe customer
- **WHEN** a second `checkout.session.completed` event names a Stripe customer or subscription that already has a licence
- **THEN** no second company, licence or user is created
- **AND** the event answers `200` and the conflict is logged by company ID

#### Scenario: The checkout's subscription changed before the event was handled
- **WHEN** the subscription was moved to Growth in Stripe after a Starter checkout and before the event was processed
- **THEN** the licence is created from the subscription as Stripe returns it when the event is handled

### Requirement: Starter starts a 14-day trial
<!-- source: B14 · PRD "Pricing" -->
A `starter` checkout SHALL create the company with `status` `trial` and `licenses.trial_ends_at` 14 days after the event. `growth` and `enterprise` MUST start `active`.

#### Scenario: A Starter checkout
- **WHEN** a checkout for the Starter price completes
- **THEN** the company's `status` is `trial` and `trial_ends_at` is 14 days ahead

#### Scenario: The trial end passes without a Stripe event
- **WHEN** `trial_ends_at` passes and Stripe has sent no subscription event
- **THEN** the company stays `trial` and is still served

### Requirement: Signup creates the install and policy defaults
<!-- source: D43 · B6 · D19 · D4 · D25 · Plan-v3.2 §4.4 -->
In the same transaction, the API SHALL generate the licence key (see `license-key`) and an uninstall token stored as `uninstall_token_hash` and `uninstall_token_ciphertext`, set `notice_text` to the default from `packages/shared` with `notice_version` 1, and insert the default `sensitive_domains` (`is_default` true) and default `productivity_rules` from `packages/shared`. A failure MUST leave no company row.

#### Scenario: Defaults are seeded
- **WHEN** a company is created
- **THEN** it has every default sensitive domain with `is_default` true and every default productivity rule
- **AND** `notice_version` is 1

#### Scenario: Seeding fails half-way
- **WHEN** inserting the default productivity rules fails after the company and licence rows were inserted
- **THEN** no `companies`, `licenses` or Supabase Auth user exists for the checkout
- **AND** `stripe_events.processed_at` stays NULL so Stripe's retry runs the handler again

### Requirement: The buyer becomes the first company admin
<!-- source: D41 · PRD "Users and roles" -->
The API SHALL create a Supabase Auth user for the checkout's email with `app_metadata` `{ role: company_admin, company_id }` and the matching `users` row, and MUST NOT create an `invitations` row for it. When that email already belongs to a `users` row, the company MUST still be created and the welcome email MUST go to the checkout email without a sign-in link, and the conflict MUST be logged by company ID.

#### Scenario: A new buyer
- **WHEN** a checkout completes for `owner@acme.com`
- **THEN** a `users` row with role `company_admin` and the new `company_id` exists

#### Scenario: The buyer is already a user of another company
- **WHEN** a checkout completes for `owner@acme.com`, which is a `manager` of another company
- **THEN** the new company is created with no `users` row for that email
- **AND** the welcome email carries the key and dashboard URL but no sign-in link

#### Scenario: The buyer's email differs only in case
- **WHEN** a checkout email is `Owner@Acme.com` and a `users` row holds `owner@acme.com`
- **THEN** it is treated as the same email

### Requirement: A welcome email carries the key and the dashboard address
<!-- source: PRD "Purchase, license and install" · Plan-v3.2 §5.3 step 1 -->
After the transaction commits, the API SHALL send one welcome email through Resend to the checkout email with the licence key, the dashboard URL `https://{slug}.workbeat.io` and a link to set a password. Neither the key nor the link MUST be logged.

#### Scenario: The welcome email
- **WHEN** a company is created
- **THEN** one email reaches the buyer with the key `WB-XXXX-XXXX-XXXX-XXXX` and `https://acme-ltd.workbeat.io`

### Requirement: A failed webhook handler is retried by Stripe
<!-- source: Plan-v3.2 §4.4 "Company, subscription and licence" · D13 -->
When a handler fails, the API SHALL roll back its writes, leave `stripe_events.processed_at` NULL and answer `500 INTERNAL`, so Stripe redelivers the event. A redelivery of an event whose row exists with `processed_at` NULL MUST run the handler again; concurrent deliveries of one `id` MUST be serialised on that row.

#### Scenario: The database is briefly unavailable
- **WHEN** the handler for a `customer.subscription.updated` event fails on a lost connection
- **THEN** the response is `500` with `code` `INTERNAL` and `processed_at` is NULL
- **AND** Stripe's next delivery of the event applies it once

#### Scenario: An event type the API does not handle
- **WHEN** Stripe sends `customer.created`
- **THEN** the event is stored with `processed_at` set and the response is `200` with no other write

### Requirement: Every company gets a usable slug
<!-- source: PRD "Tenants and custom domains" · data-model.md "companies" · Plan-v3.2 §4.4 -->
The slug SHALL match `^[a-z0-9]+(-[a-z0-9]+)*$` and be at most 32 characters including any numeric suffix. A name with no ASCII letter or digit MUST get the base `company`; a slug in the reserved list in `packages/shared` (such as `www`, `api`, `admin`, `staff`) MUST be treated as taken. Two signups racing for one slug MUST both succeed with different slugs.

#### Scenario: A long name
- **WHEN** a checkout completes for a 60-character company name whose slug `acme-…` is taken
- **THEN** the slug is cut so that it and its `-2` suffix total at most 32 characters with no trailing hyphen

#### Scenario: A name with no Latin characters
- **WHEN** a checkout completes for "株式会社"
- **THEN** the slug is `company`, or `company-2` when that is taken

#### Scenario: A reserved word
- **WHEN** a checkout completes for "API"
- **THEN** the slug is `api-2`, never `api`

#### Scenario: Two companies named Acme Ltd sign up at once
- **WHEN** two checkouts for "Acme Ltd" are handled concurrently
- **THEN** one company gets `acme-ltd` and the other `acme-ltd-2`

### Requirement: A failed welcome email never undoes the signup
<!-- source: PRD "Purchase, license and install" · Plan-v3.2 §5.3 step 1 -->
When Resend refuses or times out on the welcome email, the API SHALL retry it up to the attempt count in `packages/shared` with backoff, and after the last failure MUST log the failure by company ID and keep the company, licence and user. The event MUST stay processed: a Stripe redelivery MUST NOT resend the email or create anything.

#### Scenario: Resend is down during signup
- **WHEN** every attempt to send the welcome email fails
- **THEN** the company exists with its licence and first admin
- **AND** the log holds the company ID and no key or link

#### Scenario: Resend recovers on the second attempt
- **WHEN** the first send times out and the second is accepted
- **THEN** the buyer receives exactly one welcome email
