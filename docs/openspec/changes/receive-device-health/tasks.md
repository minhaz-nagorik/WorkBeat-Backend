> **Read first — this task list is not the requirement.**
> Capabilities: `heartbeat · notice-acknowledgement · device-status`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show receive-device-health`.
> Contract: [agent-contract.md](../../../core/api/agent-contract.md) · Schema: [data-model.md](../../../core/architecture/data-model.md).

## 1. heartbeat

- [ ] 1.1 Heartbeat zod schema in `packages/shared`, including Windows `permissions` = `not_required` (W11)
- [ ] 1.2 `POST /v1/agents/heartbeat`: update the device row, `health` and `last_heartbeat_at` in one transaction
- [ ] 1.3 Pause in force for the device's employee (not cancelled, `starts_at` ≤ now < `ends_at`, latest `ends_at`) and `policy_version` from `agent-policy`
- [ ] 1.4 Write path that still runs when `device-authentication` answers `402`, and never on `401`
- [ ] 1.5 Tests: `402` heartbeat updates `last_heartbeat_at`; `401` writes nothing; pause extended / cancelled reaches the next response; invalid body leaves the row unchanged
- [ ] 1.6 `last_heartbeat_at = greatest(last_heartbeat_at, now())` in the update
- [ ] 1.7 Edge tests: unknown fields (`enrolled_via`, a new one) → 200, not stored; omitted `os_version` kept; all-zero counters accepted; repeated body → same row, later `last_heartbeat_at`; future pause → null; `starts_at` boundary in, `ends_at` boundary out; replaced key → 401, nothing written; ended company hourly → 402 and recorded; unknown `helper_status` → 422; concurrent heartbeats → last commit wins, time never decreases; delayed retry → time never decreases
- [x] 1.8 `input_idle_seconds` (optional, ignored when invalid) → `devices.last_input_at` = now − value, NULL when absent; migration 0012 (19 Nov 2026)

## 2. notice-acknowledgement

- [ ] 2.1 Insert on `(device_id, notice_version)` conflict do nothing; set `notice_ack_version` to the max; ignore versions above the company's
- [ ] 2.2 `GET /v1/employees/:id/notice-acknowledgements` for `company_admin`
- [ ] 2.3 Tests: 12 heartbeats → one row; release and a new binding keep the old row with the old binding and employee; manager → 403; tenant isolation: another company's employee → 404 and no rows
- [ ] 2.4 Edge tests: concurrent identical acks → one row; older version after a newer one → row written, `notice_ack_version` kept; ack on a `402` heartbeat recorded; current version recorded; archived employee listed; `it_admin` → 403; version without a time → 200, no row

## 3. offline-detection

Removed (B34, 23 Nov 2026): no `/cron/heartbeat-check`; offline is derived in `device-status` (4.6).

## 4. device-status

- [ ] 4.1 Status and badge derivation in one query helper shared by the device list, rollout and `dashboard-summary`
- [x] 4.7 No `tamper` status or presence (B31): an open tamper alert is the `open_alert` badge; rollout and dashboard count it
- [ ] 4.2 `GET /v1/devices`, `GET /v1/devices/:id`, `GET /v1/rollout` for `company_admin` and `it_admin`
- [ ] 4.3 Semver comparison of `agent_version` against the effective minimum (`companies.min_agent_version` only, until `distribute-agents` ships)
- [ ] 4.4 Tests: status order; Windows never `permission_pending`; manager and staff refused; tenant isolation: two companies' devices never appear in each other's list or counts
- [ ] 4.6 Offline from `last_heartbeat_at` (or `enrolled_at`) older than 15 min at read time; drop the `offline_since` check from `deviceStatus()`
- [ ] 4.5 Edge tests: exactly 15 min → online; never heartbeated past 15 min → offline; suspended company heartbeating → online; new device `online` before its first heartbeat; on-minimum not `outdated`; 1.10.0 > 1.9.0; pause in force with null `active_pause_id` → `paused`, future pause → none; Windows never `permission_pending`; archived employee's devices listed; another company's `employee_id` filter → empty; no devices → all zero; `super_admin` → 403
