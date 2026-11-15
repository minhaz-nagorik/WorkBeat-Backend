## Why

Tampering is only worth detecting if someone hears about it. The agents report five event types
within 10 seconds, de-duplicated with a repeat count, and never drop one (D24); the backend raises
`offline` itself (D24, Plan-v3.2 §6.4). The PRD wants a tamper event on the dashboard within a
minute (PRD "Success metrics"), visible to the admin, IT and the employee's manager (PRD
"Permission matrix"), and emailed to the roles the company picked (Plan-v3.2 §4.4 "Tamper event
processing and alerting").

## What Changes

- **`POST /v1/agents/tamper`** stores one event, idempotent on `id`, with a hostname snapshot; refuses
  `offline` and unknown types with `422`. An unresolved event makes the device's status `tamper`.
- **`GET /v1/alerts`** lists tamper and offline events for the admin and IT (all devices) and managers
  (their team's devices), filterable by type and state; **`POST /v1/alerts/:id/resolve`** closes one.
  Offline alerts close on the next heartbeat (receive-device-health).
- **Alert emails** through Resend per `companies.alert_email`: instant within a minute, or an hourly
  or daily digest from **`/cron/alert-digest`**; each event emailed once (`emailed_at`); no URL,
  window title or event detail in any email.

## Capabilities

### New Capabilities

- `tamper-ingestion`: the tamper route, its idempotency, validation and stored fields.
- `alerts-feed`: who sees which alerts, filters, resolution and freshness.
- `alert-emails`: recipients, delivery modes, the digest job and what an email may contain.

### Modified Capabilities

None.

## Impact

- Consumed by both agents: `detect-tampering` (`tamper-detection`, `watchdog`), and the store rule
  that tamper events are never dropped (`buffer-and-sync/offline-store`).
- Depends on `enroll-devices` (`device-authentication`: `401` and `402`, including during a
  suspension, when the agent buffers events, D35) and `receive-device-health` (`offline-detection`
  raises `offline`; `heartbeat` resolves it; `device-status` derives `tamper`).
- `configure-company` (`company-settings`) edits `companies.alert_email`; `run-scheduled-jobs`
  (`cron-routes`) authenticates `/cron/alert-digest`.
- Schema: `tamper_events`, `companies.alert_email`, `users`, `employees`. No migration.
