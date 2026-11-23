> **Read first — this task list is not the requirement.**
> Capabilities: `company-signup · subscription-sync · company-status · license-key`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show provision-companies`.
> Contract: [agent-contract.md](../../../core/api/agent-contract.md) · Schema: [data-model.md](../../../core/architecture/data-model.md).

## 1. company-signup

- [ ] 1.1 `POST /v1/webhooks/stripe`: raw-body signature check, insert into `stripe_events` first, set `processed_at` after the handler commits
- [ ] 1.2 Price → plan and price → screenshot tier maps, plan seat limits, trial length, default notice text, default sensitive domains and productivity rules in `packages/shared`
- [ ] 1.3 Slug generator (lowercase, hyphens, ≤ 32, numeric suffix on collision)
- [ ] 1.4 Company, licence, uninstall token, defaults and first admin in one `tenant`-scope transaction for the new company ID; `users` row without a password and a set-password link (B24); welcome email after commit
- [ ] 1.5 Tests: same event twice → one company; bad signature → 400 and nothing stored; slug collision; Starter → `trial` with `trial_ends_at`; welcome email carries the key and URL, the log carries neither; tenant isolation: the new company's defaults are invisible to another company
- [ ] 1.6 Row lock on the `stripe_events` row so concurrent deliveries of one `id` serialise; handler failure rolls back, leaves `processed_at` NULL and answers 500; unhandled event types stored as processed
- [ ] 1.7 Slug: reserved list in `packages/shared`, `company` fallback, truncation with suffix ≤ 32, retry on unique violation; welcome email retry count and backoff in `packages/shared`
- [ ] 1.8 Tests (edge cases): concurrent duplicate delivery → handler once; replay of an old processed event → no change; tampered body → 400; handler failure → 500 then retry applies once; second checkout for the same customer → nothing created; buyer already a user elsewhere (also case-differing email) → company created, no sign-in link; seeding failure leaves no company; long, non-Latin and reserved names; two concurrent "Acme Ltd" signups; Resend down → company kept, failure logged by company ID, redelivery sends no second email; `trial_ends_at` passing alone keeps `trial`

## 2. subscription-sync

- [x] 2.1 `db/migrations/0002_spec_gaps.sql`: `company_by_stripe_customer(p_customer_id text) RETURNS uuid`, `SECURITY DEFINER`, granted to `workbeat_api`, with its self-check
- [ ] 2.2 Handlers for `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.paid`
- [ ] 2.3 Tier lowering: one `UPDATE` of `employee_monitoring_settings` in the same transaction
- [ ] 2.4 `GET /v1/billing`, `PUT /v1/billing/screenshot-tier` (Stripe change scheduled at the period end), `POST /v1/billing/portal-session`
- [ ] 2.5 Tests: renewal failure → `suspended`/`payment_failed` at once; `invoice.paid` restores it but not a `staff` suspension; deletion → `expired` and `expired_at`; tier `standard` → `light` moves 600 and 1800 to 3600, leaves 0; tier `off` → all 0; events delivered out of order leave the licence matching the subscription Stripe returns now; tenant isolation: company A's event never touches company B's settings
- [ ] 2.6 Invoice handlers re-read the invoice from Stripe; `payment_failed` never overwrites a `staff` reason; invoice events ignore `expired` companies; unknown customer → 200, no change
- [ ] 2.7 Tests (edge cases): `payment_failed` then `paid` 2 s apart → active; `paid` before `failed` → not suspended; staff suspension + `payment_failed` → reason stays `staff`; deletion while suspended → `expired`, reason NULL; second deletion keeps `expired_at`; tier replay changes no row; `intensive` → `off` sets all to 0; scheduled downgrade then cancelled → no schedule; Growth → Starter with 30 devices keeps all 30 and refuses enrollment 31 until seats < 10; Enterprise renewal keeps the staff `seat_limit`; it_admin → 403 on billing; billing works while suspended

## 3. company-status

- [ ] 3.1 Status and `blocking_ends_at` read model shared with `enroll-devices`
- [ ] 3.2 `GET /v1/company/status`
- [ ] 3.3 Tests: `blocking_ends_at` = `expired_at` + grace days, and moves when staff change the grace; `trial` behaves as `active`; tenant isolation: a user reads only their own company's status
- [ ] 3.4 Tests (edge cases): grace 0 → `blocking_ends_at` = `expired_at`; non-expired → `null`; past `blocking_ends_at` still `LICENSE_EXPIRED`; `staff` suspension answers `COMPANY_SUSPENDED`; `company_id` in the query ignored; `status` in a company write ignored

## 4. license-key

- [ ] 4.1 Key generator (`WB-XXXX-XXXX-XXXX-XXXX`), SHA-256 of the normalised key, AES-256-GCM with the environment key (B6)
- [ ] 4.2 `GET /v1/license` and `POST /v1/license/reveal` with `Cache-Control: no-store`
- [ ] 4.3 Seats-used query on `devices` (`released_at` NULL)
- [ ] 4.4 Tests: manager → 403; revealed key equals the emailed key; lower-case key with spaces hashes to the same `key_hash`; released devices are not counted; the key never appears in a log; tenant isolation: company A cannot reveal company B's key
- [ ] 4.5 Tests (edge cases): key-hash collision regenerates; reveal after reissue returns the new key; seats used above the limit reported as is; unlimited seats → `null`; manager → 403 on reveal and uninstall token; license read works while suspended
- [x] 4.6 B29: `GET /v1/billing` refused to every company role; the not-yet-built tier and portal routes must do the same
