## Why

Tampering is only worth detecting if someone hears about it. The agents report five event types
within 10 seconds, de-duplicated with a repeat count, and never drop one (D24); the backend raises,
on a re-enrollment while the old key is live, `duplicate_device_id` (D46, Plan-v3.5 §4.4). The PRD wants a tamper event on the dashboard within a
minute (PRD "Success metrics"), visible to the admin, IT and the employee's manager (PRD
"Permission matrix"). There are no alert emails and no stored `offline` event (B34): a silent device
shows as `offline` on the device list, derived from its last heartbeat.

## What Changes

- **`POST /v1/agents/tamper`** stores one event, idempotent on `id`, with a hostname snapshot; refuses
  `offline`, `duplicate_device_id` and unknown types with `422`. An unresolved event makes the device's status `tamper`.
- **`GET /v1/alerts`** lists tamper events for the admin and IT (all devices) and managers
  (their team's devices), filterable by type and state; **`POST /v1/alerts/:id/resolve`** closes one.

## Capabilities

### New Capabilities

- `tamper-ingestion`: the tamper route, its idempotency, validation and stored fields.
- `alerts-feed`: who sees which alerts, filters, resolution and freshness.

### Modified Capabilities

None.

## Impact

- Consumed by both agents: `detect-tampering` (`tamper-detection`, `watchdog`), and the store rule
  that tamper events are never dropped (`buffer-and-sync/offline-store`).
- Depends on `enroll-devices` (`device-authentication`: `401` and `402`, including during a
  suspension, when the agent buffers events, D35) and `receive-device-health` (`device-status` derives the
  `open_alert` badge).
- Schema: `tamper_events`, `users`, `employees`. No migration; `companies.alert_email` and
  `tamper_events.emailed_at` stay in the schema unused (B34).
