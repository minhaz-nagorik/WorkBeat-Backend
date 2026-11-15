> **Read first — this task list is not the requirement.**
> Capabilities: `heartbeat · notice-acknowledgement · offline-detection · device-status`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show receive-device-health`.
> Contract: [agent-contract.md](../../../core/api/agent-contract.md) · Schema: [data-model.md](../../../core/architecture/data-model.md).

## 1. heartbeat

- [ ] 1.1 Heartbeat zod schema in `packages/shared`, including Windows `permissions` = `not_required` (W11)
- [ ] 1.2 `POST /v1/agents/heartbeat`: update the device row and `health` in one transaction; clear `offline_since`, resolve the open `offline` event
- [ ] 1.3 Pause in force for the device's employee (not cancelled, `starts_at` ≤ now < `ends_at`, latest `ends_at`) and `policy_version` from `agent-policy`
- [ ] 1.4 Write path that still runs when `device-authentication` answers `402`, and never on `401`
- [ ] 1.5 Tests: `402` heartbeat updates `last_heartbeat_at`; `401` writes nothing; pause extended / cancelled reaches the next response; invalid body leaves the row unchanged
- [ ] 1.6 `last_heartbeat_at = greatest(last_heartbeat_at, now())` in the update
- [ ] 1.7 Edge tests: unknown fields (`enrolled_via`, a new one) → 200, not stored; omitted `os_version` kept; all-zero counters accepted; repeated body → same row, later `last_heartbeat_at`; future pause → null; `starts_at` boundary in, `ends_at` boundary out; deactivated → 401, nothing written; ended company hourly → 402 and recorded; unknown `helper_status` → 422; concurrent heartbeats → last commit wins, time never decreases; delayed retry → time never decreases

## 2. notice-acknowledgement

- [ ] 2.1 Insert on `(device_id, notice_version)` conflict do nothing; set `notice_ack_version` to the max; ignore versions above the company's
- [ ] 2.2 `GET /v1/employees/:id/notice-acknowledgements` for `company_admin`
- [ ] 2.3 Tests: 12 heartbeats → one row; reassignment keeps the old employee; manager → 403; tenant isolation: another company's employee → 404 and no rows
- [ ] 2.4 Edge tests: concurrent identical acks → one row; older version after a newer one → row written, `notice_ack_version` kept; ack on a `402` heartbeat recorded; current version recorded; archived employee listed; `it_admin` → 403; version without a time → 200, no row

## 3. offline-detection

- [ ] 3.1 `/cron/heartbeat-check` handler: one `UPDATE … WHERE offline_since IS NULL … RETURNING` then insert the `offline` events, in `system` scope
- [ ] 3.2 Skip released, deactivated and companies past `blocking_ends_at` (`expired_at` + `expired_blocking_grace_days`)
- [ ] 3.3 Hand each new event to `alert-emails` (process-tamper-alerts)
- [ ] 3.4 Tests: 16 min silent → one event; two concurrent runs → one event; released and ended devices skipped; heartbeat resolves it
- [ ] 3.5 Mark and insert the event in one transaction; the `UPDATE` re-checks `last_heartbeat_at` and `offline_since` on the locked row
- [ ] 3.6 Edge tests: exactly 15 min → not offline; never heartbeated past 15 min → offline; suspended and in-grace expired devices checked; second offline period → second event; deactivated skipped; heartbeat committed mid-run → not marked; heartbeat waiting on the job → clears and resolves the new event

## 4. device-status

- [ ] 4.1 Status and badge derivation in one query helper shared by the device list, rollout and `dashboard-summary`
- [ ] 4.2 `GET /v1/devices`, `GET /v1/devices/:id`, `GET /v1/rollout` for `company_admin` and `it_admin`
- [ ] 4.3 Semver comparison of `agent_version` against the effective minimum (`companies.min_agent_version` only, until `distribute-agents` ships)
- [ ] 4.4 Tests: status order; Windows never `permission_pending`; manager and staff refused; tenant isolation: two companies' devices never appear in each other's list or counts
- [ ] 4.5 Edge tests: deactivated beats offline; new device `online` before its first heartbeat; on-minimum not `outdated`; 1.10.0 > 1.9.0; pause in force with null `active_pause_id` → `paused`, future pause → none; Windows never `permission_pending`; archived employee's devices listed; another company's `employee_id` filter → empty; no devices → all zero; `super_admin` → 403
