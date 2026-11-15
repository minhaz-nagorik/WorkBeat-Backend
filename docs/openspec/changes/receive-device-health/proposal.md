## Why

The portal's whole view of a fleet comes from one call every 5 minutes. The heartbeat must record
the latest health, tell the agent its policy version and the pause in force (D31, D32), carry the
notice acknowledgement that is the company's legal evidence (D25), and keep a suspended device from
looking offline (D5). Offline is raised only by the backend after 15 minutes of silence, never for
a released device (D24, D38, Plan-v3.2 §6.4), and the rollout dashboard derives every status from
these fields (Plan-v3.2 §2.4, §5.9).

## What Changes

- **`POST /v1/agents/heartbeat`** stores the latest health on `devices` (no history), clears
  `offline_since`, resolves the open `offline` event, and returns `policy_version` and
  `monitoring_pause`. A heartbeat answered with `402` is still recorded.
- **Notice acknowledgements** are written once per device and notice version, append-only, and
  listed per employee for the company admin (D25).
- **`/cron/heartbeat-check`** marks a device offline after 15 minutes without a heartbeat and raises
  exactly one `offline` event; never for released, deactivated or ended devices (D36, D38).
- **Device status is derived, never stored**: released, deactivated, tamper, offline, online, with
  badges outdated, permission pending, browser access pending and paused. No unassigned status
  (D44). `GET /v1/devices`, `GET /v1/devices/:id` and `GET /v1/rollout` serve it.

## Capabilities

### New Capabilities

- `heartbeat`: what a heartbeat stores, what it returns, and what happens under `402`.
- `notice-acknowledgement`: the append-only acknowledgement record and its listing.
- `offline-detection`: the 5-minute job, the 15-minute threshold and the one `offline` event.
- `device-status`: the derived status and badges, the device list and the rollout counts.

### Modified Capabilities

None.

## Impact

- Consumed by both agents: `report-device-health` (`heartbeat`, `monitoring-pause`,
  `policy-refresh`, `suspended-company`) and `detect-tampering` (`tamper-detection`: the agent never
  sends `offline`); Windows `permissions` = `not_required` (W11).
- Depends on `enroll-devices` (`device-authentication` answers `401` and `402` on every agent route)
  and `serve-agent-policy` (`agent-policy` resolves the device's `policy_version`, B5).
- `process-tamper-alerts` emails and lists the `offline` events raised here; `report-usage`
  (`dashboard-summary`) counts devices by the status derived here.
- Schema: `devices`, `notice_acknowledgements`, `tamper_events`, `monitoring_pauses`. No migration.
