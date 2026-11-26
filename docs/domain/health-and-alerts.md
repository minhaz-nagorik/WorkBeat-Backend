# Health and alerts

How a heartbeat becomes device fields, how the portal names a device's state, when a device is
offline, and how tamper events become alerts. The agent's view is each agent
repository's `docs/domain/tamper-events.md`. Requirements:
[`heartbeat`](../openspec/changes/receive-device-health/specs/heartbeat/spec.md),
[`device-status`](../openspec/changes/receive-device-health/specs/device-status/spec.md),
[`notice-acknowledgement`](../openspec/changes/receive-device-health/specs/notice-acknowledgement/spec.md),
[`tamper-ingestion`](../openspec/changes/process-tamper-alerts/specs/tamper-ingestion/spec.md),
[`alerts-feed`](../openspec/changes/process-tamper-alerts/specs/alerts-feed/spec.md).

## Heartbeat → device fields

Every 5 minutes. Only the latest values are kept; there is no heartbeat history.

| Wire field | Stored in |
|---|---|
| `agent_version`, `os_version` | `devices.agent_version`, `os_version` |
| `policy_version` | `devices.reported_policy_version` |
| `helper_status`, `browser_access`, `permissions` | Same-named `jsonb` columns (Windows `permissions` = `not_required`) |
| `active_pause_id` | `devices.active_pause_id` |
| `store_bytes`, `oldest_unsent_at`, `dropped_*`, `screenshot_skips`, `quarantined_batches`, `blocking_status`, `helper_restarts_24h`, `upload_failures_24h`, `update_failure`, `uptime_seconds` | `devices.health`, replaced whole |
| `notice_version`, `notice_acknowledged_at` | One `notice_acknowledgements` row per device and version; `devices.notice_ack_version` |
| (server time) | `last_heartbeat_at` |

| Answer | What is written |
|---|---|
| `200` | All of the above. Returns `policy_version` and `monitoring_pause` |
| `402` (suspended, expired) | All of the above, so the device does not look offline (D5). Body is the `402` |
| `401` (revoked, released) | Nothing |
| `400` / `422` | Nothing, not even `last_heartbeat_at` |

Acknowledgements are append-only legal evidence (D25). A version above the company's is ignored
without failing the heartbeat. Each row belongs to the binding that sent it; a new binding on the same device asks again.

## Derived status

Computed on every read, never stored. The first row that applies wins.

| Order | Status | Condition |
|---|---|---|
| 1 | `uninstalled` | `uninstalled_at` set: removed with the uninstaller (B36) |
| 2 | `released` | `released_at` set: WorkBeat still installed, dormant |
| 3 | `offline` | `last_heartbeat_at` (or `enrolled_at` if none) more than 15 min before the read (`packages/shared`) |
| 4 | `online` | Otherwise |

There is no `unassigned` status (D47), no `tamper` status (B31) and no `deactivated` status (B35).

| Badge | When |
|---|---|
| `outdated` | `agent_version` below the effective minimum |
| `permission_pending` | A macOS `permissions` entry not granted. Never on Windows |
| `browser_access_pending` | A `browser_access` entry `pending` or `unreadable` (D39) |
| `paused` | `active_pause_id` set, or a pause in force |
| `open_alert` | An unresolved tamper event (B31) |

`GET /v1/rollout` counts per status and badge; `healthy` = `online` with no badge. Devices,
device detail and rollout are for `company_admin` and `it_admin` only.

## Offline

A device is `offline` when its last heartbeat is more than 15 minutes old, decided each time the
status is read. Nothing is stored, no event is raised and nobody is emailed; there is no
`/cron/heartbeat-check` (B34). Suspended devices keep heartbeating, so they stay online. An
expired company's devices past `blocking_ends_at` heartbeat hourly, so they show offline most of
the time.

## Tamper events

| `event_type` | Source |
|---|---|
| `process_restart`, `hosts_modified`, `config_changed`, `clock_tampered`, `permission_revoked` | Agent, `POST /v1/agents/tamper`, within seconds of detection |
| `duplicate_device_id` | Backend only, on a re-enrollment while the old key is live (D46); an agent sending it gets `422` |

`offline` is not a tamper event (B34); an agent sending it gets `422`.

| Rule | Detail |
|---|---|
| Dedupe on `id` | The agent's UUIDv7 is the key. Same id, same device and type → `200` with the stored values. Other type or device → `409 IDEMPOTENCY_KEY_REUSED` |
| Any age | Exempt from the B7 window; a future `occurred_at` is stored as server time |
| Snapshot | `hostname` copied at receipt, so it survives renames and release |
| Resolve | `POST /v1/alerts/:id/resolve` by `company_admin` / `it_admin` sets `resolved_at`, `resolved_by`. Repeat is a no-op |
| Badge | While unresolved, the device has the `open_alert` badge (B31) |

## Alert emails

There are none (B34). Alerts are read in the portal's feed only.

## Alerts feed by role

| Role | `GET /v1/alerts` | Resolve |
|---|---|---|
| `company_admin`, `it_admin` | Every device of the company | Yes |
| `manager` | Devices of their team | `403` |
| `super_admin` | `403` | `403` |

Newest `occurred_at` first, filtered by `type`, `state`, `device_id`, `from`, `to`, paged by
cursor. An event is listed as soon as it commits; the portal polls.

## Gaps found

None open.
