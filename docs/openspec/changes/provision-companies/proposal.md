## Why

A company exists only because Stripe says it paid or started a trial (Plan-v3.2 §4.4 "Company,
subscription and licence", PRD "Purchase, license and install"). From that one event the API
must create everything an install needs: the licence key that is the only install credential
(D43, B6), the plan's seat limit, the defaults the policy serves, and the first company admin.
Billing then drives the company's status: a failed renewal suspends at once (D29), an ended
subscription expires the licence with a blocking grace period (D30, D36), and a lower screenshot
tier pulls every employee's interval down with it (B11).

## What Changes

- **Stripe webhook** with signature check and one-time processing through `stripe_events`.
- **Signup** from `checkout.session.completed`: company, slug, licence, uninstall token, notice,
  default sensitive domains and productivity rules, first company admin, welcome email; Starter
  starts a 14-day `trial` (B14).
- **Subscription sync**: plan, seat limit, screenshot tier and period end from Stripe; suspend on
  a failed renewal, restore on payment, expire on cancellation; billing page routes.
- **Company status**: the four statuses, `blocking_ends_at`, and the `402` codes the agent routes
  return (enforced by `enroll-devices`).
- **Licence key**: masked view, reveal, and the seats-used count (B4).

## Capabilities

### New Capabilities

- `company-signup`: the webhook route and the company created from a checkout.
- `subscription-sync`: plan, seats, tier, suspension, expiry, and the billing routes.
- `company-status`: status values, `blocking_ends_at`, the codes agents get.
- `license-key`: key format and storage, view and reveal, seats used.

### Modified Capabilities

None.

## Impact

- Consumed by the web platform (billing, deployment pages) and, through `company-status`, by
  `enroll-devices` (licence validation, enrollment, device authentication).
- Depends on `authenticate-users` for the first company admin's account.
- New code: `WEBHOOK_SIGNATURE_INVALID`.
- Schema: `companies`, `licenses`, `stripe_events`, `users`, `sensitive_domains`,
  `productivity_rules`. Adds to `db/migrations/0002`: `company_by_stripe_customer(text)`, a
  `SECURITY DEFINER` lookup so a subscription event finds its company without leaving `tenant`
  scope (B3).
