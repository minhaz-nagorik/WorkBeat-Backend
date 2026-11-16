# Health and alerts

How a heartbeat becomes device fields, how the portal names a device's state, when a device is
offline, and how tamper events become alerts and emails. The agent's view is each agent
repository's `docs/domain/tamper-events.md`. Requirements:
[`heartbeat`](../openspec/changes/receive-device-health/specs/heartbeat/spec.md),
[`device-status`](../openspec/changes/receive-device-health/specs/device-status/spec.md),
[`offline-detection`](../openspec/changes/receive-device-health/specs/offline-detection/spec.md),
[`notice-acknowledgement`](../openspec/changes/receive-device-health/specs/notice-acknowledgement/spec.md),
[`tamper-ingestion`](../openspec/changes/process-tamper-alerts/specs/tamper-ingestion/spec.md),
[`alert-emails`](../openspec/changes/process-tamper-alerts/specs/alert-emails/spec.md),
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
| (server time) | `last_heartbeat_at`; `offline_since` cleared; open `offline` event resolved |

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
| 1 | `released` | `released_at` set |
| 2 | `deactivated` | `deactivated_at` set |
| 3 | `tamper` | An unresolved tamper event other than `offline` |
| 4 | `offline` | `offline_since` set |
| 5 | `online` | Otherwise |

There is no `unassigned` status (D47).

| Badge | When |
|---|---|
| `outdated` | `agent_version` below the effective minimum |
| `permission_pending` | A macOS `permissions` entry not granted. Never on Windows |
| `browser_access_pending` | A `browser_access` entry `pending` or `unreadable` (D39) |
| `paused` | `active_pause_id` set, or a pause in force |

`GET /v1/rollout` counts per status and badge; `healthy` = `online` with no badge. Devices,
device detail and rollout are for `company_admin` and `it_admin` only.

## Offline detection

`/cron/heartbeat-check` runs every 5 minutes in `system` scope.

| Rule | Detail |
|---|---|
| Threshold | `last_heartbeat_at` (or `enrolled_at` if none) older than 15 min (`packages/shared`) and `offline_since` NULL |
| Effect | Set `offline_since`; insert one `offline` event with a server id, current `hostname`, `occurred_at` = run time, `detail.last_heartbeat_at` |
| Once per period | No second event until a heartbeat clears `offline_since`; concurrent runs are stopped by the job lock |
| Excluded | Released, deactivated, and devices of an expired company past `blocking_ends_at` (they heartbeat hourly) |
| Back online | The next heartbeat clears `offline_since` and sets `resolved_at` on the event; `resolved_by` stays NULL |

Offline is raised only by the backend (D24). Suspended devices keep heartbeating, so they stay
online.

## Tamper events

| `event_type` | Source |
|---|---|
| `process_restart`, `hosts_modified`, `config_changed`, `clock_tampered`, `permission_revoked` | Agent, `POST /v1/agents/tamper`, within seconds of detection |
| `offline` | Backend only; an agent sending it gets `422` |

| Rule | Detail |
|---|---|
| Dedupe on `id` | The agent's UUIDv7 is the key. Same id, same device and type → `200` with the stored values. Other type or device → `409 IDEMPOTENCY_KEY_REUSED` |
| Any age | Exempt from the B7 window; a future `occurred_at` is stored as server time |
| Snapshot | `hostname` copied at receipt, so it survives renames and release |
| Resolve | `POST /v1/alerts/:id/resolve` by `company_admin` / `it_admin` sets `resolved_at`, `resolved_by`. Repeat is a no-op. Offline events resolve themselves on the next heartbeat |
| Status | While unresolved, the device is `tamper` |

## Alert emails

| Setting (`companies.alert_email`) | Meaning |
|---|---|
| `types` | Event types that are emailed; default all six |
| `roles` | Subset of `company_admin`, `manager`, `it_admin`; disabled users excluded; managers only for their team; never `super_admin` |
| `delivery` | `instant`, `hourly` or `daily` |

| Delivery | When |
|---|---|
| `instant` | One email per event within 1 minute, after commit |
| `hourly` | `/cron/alert-digest` (hourly) lists the last hour's unemailed events per recipient |
| `daily` | The run at 09:00 in the company `timezone` lists the last 24 hours (B19) |
| Retry | A failed instant email is sent by the next digest run while under 24 hours old |

`emailed_at` is set once per event; it is never emailed again. An email holds the event type,
hostname, employee name, `occurred_at` and `repeat_count` only: no `detail`, URL, title or
signed URL.

## Alerts feed by role

| Role | `GET /v1/alerts` | Resolve |
|---|---|---|
| `company_admin`, `it_admin` | Every device of the company | Yes |
| `manager` | Devices of their team | `403` |
| `super_admin` | `403` | `403` |

Newest `occurred_at` first, filtered by `type`, `state`, `device_id`, `from`, `to`, paged by
cursor. An event is listed as soon as it commits; the portal polls.

## Gaps found

- **Stale design.** [process-tamper-alerts design.md](../openspec/changes/process-tamper-alerts/design.md)
  says there is no company timezone and the daily digest is at 09:00 UTC; `alert-emails`, B19 and
  `0002` use the company `timezone`.
- **Old unsent emails.** An instant email still failing after 24 hours is never sent and its
  `emailed_at` stays NULL; the spec does not say whether that is intended.
- **`cron-routes`** lists the digest job but Plan v3.5 §6.4 does not; the design amends it.
