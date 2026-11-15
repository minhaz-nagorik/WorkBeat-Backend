## Why

After signup a company admin tunes the company: its name, how long data is kept (B13, PRD
"Retention and suspension"), who gets alert emails, the idle threshold every device uses, and the
onboarding checklist that walks IT to the first device (Plan-v3.2 §4.5 "Onboarding",
"Settings"). A company may also open the dashboard at its own domain, proven by a DNS TXT record
and checked every five minutes (Plan-v3.2 §4.4, §6.4, PRD "Tenants and custom domains").

## What Changes

- **Company settings** read and write: `name`, `data_retention_days` (1–365),
  `idle_threshold_seconds`, `alert_email`.
- **Setup checklist**: two steps marked by the admin, two derived from devices.
- **Custom domain**: set, read with the DNS records to create, remove; the `/cron/domain-verify`
  job that activates it; host lookup through `company_by_host`.

## Capabilities

### New Capabilities

- `company-settings`: company profile, retention, idle threshold, alert email, setup checklist.
- `custom-domains`: domain setup, DNS verification job, host resolution.

### Modified Capabilities

None.

## Impact

- Consumed by the web platform (Settings, Onboarding, sign-in page on a company host).
- `alert_email` is read by `process-tamper-alerts` (`alert-emails`); `data_retention_days` by
  `run-scheduled-jobs` (`data-retention`); `idle_threshold_seconds` reaches devices through
  `serve-agent-policy` (`agent-policy`). The notice text belongs to `collection-notice`.
- The cron route's scheduling and secret are `run-scheduled-jobs` (`cron-routes`).
- Schema: `companies` columns in `db/migrations/0001_init.sql`; no change.
