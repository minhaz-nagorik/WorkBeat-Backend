# Webhooks, cron and health

Routes called by Stripe, by the scheduler, and by uptime checks. None takes a user token.
Conventions and the code catalog are in [README.md](README.md).

Contents: [Stripe webhook](#stripe-webhook) · [Cron jobs](#cron-jobs) · [Health](#health) ·
[Unspecified](#unspecified)

---

## Stripe webhook

### `POST /v1/webhooks/stripe`
Roles: none; Stripe, authenticated by `Stripe-Signature` · Spec: [`company-signup`][company-signup], [`subscription-sync`][subscription-sync]
Receive one Stripe event and apply it to the company it concerns.
Request: the raw Stripe event body; header `Stripe-Signature`.
Response `200`: body not specified.
Errors:

| status | code | when |
|---|---|---|
| 400 | `WEBHOOK_SIGNATURE_INVALID` | `Stripe-Signature` missing or not valid for the raw body; nothing is stored |
| 500 | `INTERNAL` | unexpected failure (signup leaves no company row) |

**Signature.** Verified against the raw body before parsing. The signature and the Stripe secret are
never logged.

**Idempotency.** Each event is inserted into `stripe_events` by its Stripe `id` (`type`, `payload`,
`received_at`, `processed_at` (derived)). An `id` already processed answers `200` without running its
handler again; a retried `checkout.session.completed` creates exactly one company.

**Events handled:**

| Event | Effect | Spec |
|---|---|---|
| `checkout.session.completed` | One transaction: `companies` row (checkout company name; `slug` lower case, hyphens, ≤ 32 chars, numeric suffix when taken: `acme-ltd-2`); `licenses` row (`plan` from the price; `seat_limit` 10 starter, 50 growth, NULL enterprise; `screenshot_tier` `off`; Stripe customer and subscription IDs); licence key (`key_hash`, `key_ciphertext`, `key_last4`); uninstall token (`uninstall_token_hash`, `uninstall_token_ciphertext`); default `notice_text`, `notice_version` 1; default `sensitive_domains` (`is_default` true) and `productivity_rules` from `packages/shared`. `starter` → `status` `trial`, `trial_ends_at` = event + 14 days; `growth`, `enterprise` → `active`. First company admin: Supabase Auth user for the checkout email with `app_metadata` `{ role: company_admin, company_id }` and its `users` row, no `invitations` row. After commit: one welcome email (Resend) with the key, `https://{slug}.workbeat.io` and a set-password link. If the email already has a `users` row, the company is still created, the welcome email goes without a sign-in link, and the conflict is logged by company ID | [`company-signup`][company-signup] |
| `customer.subscription.updated` | Company found through `company_by_stripe_customer`; subscription read from Stripe at that moment; sets `licenses.plan`, `seat_limit` (10 / 50; enterprise unchanged from the staff value), `screenshot_tier` from the add-on item, `current_period_end`. `trial` company whose subscription turns active → `active`. A less frequent tier lowers every `employee_monitoring_settings.screenshot_interval_seconds` above 0 and below the new interval to it; `off` sets all to 0; a higher tier changes none (same transaction) | [`subscription-sync`][subscription-sync] |
| `invoice.payment_failed` (renewal) | `status` `suspended`, `suspended_reason` `payment_failed`, `suspended_at`; no grace | [`subscription-sync`][subscription-sync] |
| `invoice.paid` | A company suspended for `payment_failed` → `active`, `suspended_reason` NULL. Suspended for `staff` → unchanged | [`subscription-sync`][subscription-sync] |
| `customer.subscription.deleted` | `status` `expired`, `suspended_reason` cleared, `licenses.expired_at` = event time. Devices and seats unchanged | [`subscription-sync`][subscription-sync] |

No Stripe event creates a `super_admin` ([`staff-accounts`][staff-accounts]). Neither the licence key
nor the set-password link is logged.

---

## Cron jobs

Every scheduled job is a `POST /cron/<job>` called by Supabase pg_cron (with pg_net) or Cloud
Scheduler; the API runs no in-process timer ([`cron-routes`][cron-routes], B10). These routes have no
`/v1` prefix.

**Shared behaviour:**

- **Auth:** header `X-Cron-Secret`, compared in constant time with the configured secret. Missing or
  wrong → `401 UNAUTHENTICATED`, nothing runs. A user JWT, device key or licence key is never
  accepted. The secret is never logged.
- **Scope:** `app.scope` = `system`, no `app.company_id`, set before the first query.
- **One run at a time:** every transaction of a run first takes `pg_try_advisory_xact_lock` for its
  job; if held, the run stops and returns `200` with `skipped` true. Running twice leaves the same
  state as once.
- **Request:** none.
- **Response `200`:**

| field | type | notes |
|---|---|---|
| job | string | job name |
| started_at | ISO-8601 datetime | |
| duration_ms | int | |
| rows_affected | object | count per table (derived shape) |
| skipped | bool | lock was held |
| more | bool | time budget spent with work left (cleanup) |

- **Errors:** `401 UNAUTHENTICATED` (secret); `500 INTERNAL` (failed run; the log carries the job name
  and error class, never row values).
- **Log:** one line per run with job name, duration, rows affected per table, skipped.

| Route | Schedule | Owner change |
|---|---|---|
| `POST /cron/token-expiry` | hourly | run-scheduled-jobs |
| `POST /cron/usage-summary` | hourly | summarize-usage |
| `POST /cron/cleanup` | daily 02:00 UTC | run-scheduled-jobs |

There is no `/cron/heartbeat-check` or `/cron/alert-digest` (B34): a device's `offline` status is
worked out from `last_heartbeat_at` when it is read, and there are no alert emails.

### `POST /cron/token-expiry`
Roles: scheduler · Spec: [`cron-routes`][cron-routes]
Delete expired, unused enrollment tokens.
Notes: deletes every `enrollment_tokens` row with `used_at` NULL and `expires_at` before now, across all companies. Used tokens stay (`devices.enrollment_token_id` references them). A deleted token then answers `404 ENROLLMENT_TOKEN_INVALID`.

### `POST /cron/cleanup`
Roles: scheduler · Spec: [`data-retention`][data-retention], B15
Apply each company's retention and prepare partitions.
Notes, in order:
1. `cron_ensure_month_partitions()`: partitions from last month to two months ahead on the four partitioned tables; idempotent.
2. Per company: deletes `app_sessions`, `url_visits`, `activity_buckets`, `idle_intervals` rows older than now − `data_retention_days`, in batches (size in `packages/shared`), each batch its own short `system`-scope transaction, until done or the time budget is spent (`more` true).
3. *(Not built yet, task 3.2: screenshot rows and files are kept.)* Screenshots past retention: deletes the Storage object at `storage_path`, then the row. A failed object delete keeps the row for next run; a missing object counts as deleted.
4. Deletes `ingest_batches` older than 14 days (`received_at`) and **resolved** `tamper_events` older than retention. Unresolved events are kept.
5. `cron_drop_old_partitions(90)`: drops monthly partitions ending more than 90 days ago; the count is in `rows_affected.partitions_dropped`.

Never deletes `notice_acknowledgements`, `employees`, `devices`, `users`, `companies`, `licenses`, or
any rule or settings row. Exempt from B2's one-transaction rule (B15); each batch still sets the scope
and takes the job lock.

---

## Unspecified

- Webhook response body, and what happens to an event type not in the table (stored and `200`, or
  refused).
- Whether `invoice.payment_failed` on a non-renewal invoice does anything ("for a renewal").
- `rows_affected` shape beyond "count per table"; whether `more` is always present.

[company-signup]: ../../openspec/changes/provision-companies/specs/company-signup/spec.md
[subscription-sync]: ../../openspec/changes/provision-companies/specs/subscription-sync/spec.md
[staff-accounts]: ../../openspec/changes/authenticate-users/specs/staff-accounts/spec.md
[cron-routes]: ../../openspec/changes/run-scheduled-jobs/specs/cron-routes/spec.md
[data-retention]: ../../openspec/changes/run-scheduled-jobs/specs/data-retention/spec.md
[schema-migrations]: ../../openspec/changes/establish-api-foundation/specs/schema-migrations/spec.md
