## Why

After signup a company admin tunes the company: its name, how long data is kept (B13, PRD
"Retention and suspension"), the idle threshold every device uses, and the
onboarding checklist that walks IT to the first device (Plan-v3.5 §4.5 "Onboarding",
"Settings"). A company may also open the dashboard at its own domain: its admin adds it and WorkBeat staff
approve it after checking a DNS TXT record by hand (B33, Plan-v3.5 §4.4, PRD "Tenants and custom domains").

## What Changes

- **Company settings** read and write: `name`, `data_retention_days` (30, 60 or 90),
  `idle_threshold_seconds`, `timezone`. No alert email setting (B34).
- **Setup checklist**: two steps marked by the admin, two derived from devices.
- **Custom domain**: the company admin sets, reads (with the DNS records to create) and removes it;
  staff read the records and approve or reject it; host lookup through `company_by_host`. No cron job (B33).

## Capabilities

### New Capabilities

- `company-settings`: company profile, retention, idle threshold, timezone, setup checklist.
- `custom-domains`: domain setup, staff approval, host resolution.

### Modified Capabilities

None.

## Impact

- Consumed by the web platform (Settings, Onboarding, sign-in page on a company host).
- `data_retention_days` is read by
  `run-scheduled-jobs` (`data-retention`); `idle_threshold_seconds` reaches devices through
  `serve-agent-policy` (`agent-policy`). The notice text belongs to `collection-notice`.
- The staff Custom domains page (web platform `staff-domains`) approves domains.
- Schema: `companies` columns in `db/migrations/0001_init.sql`; no change.
