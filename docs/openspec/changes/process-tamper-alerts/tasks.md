> **Read first — this task list is not the requirement.**
> Capabilities: `tamper-ingestion · alerts-feed`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show process-tamper-alerts`.
> Contract: [agent-contract.md](../../../core/api/agent-contract.md) · Schema: [data-model.md](../../../core/architecture/data-model.md).

## 1. tamper-ingestion

- [ ] 1.1 Tamper zod schema in `packages/shared`: five event types, `repeat_count` ≥ 1, `detail` object with a size limit
- [ ] 1.2 `POST /v1/agents/tamper`: insert with hostname snapshot; on `id` conflict, a visible row of the same device and type → 200; anything else, including a row hidden by RLS → 409
- [ ] 1.3 Clamp a future `occurred_at` to server time; no B7 window
- [ ] 1.5 Tests: repeat → 200 and one row; other device's `id` → 409; `offline` → 422; `duplicate_device_id` from an agent → 422; ten-day-old event stored; `402` during suspension writes nothing
- [ ] 1.6 Tests (edge cases): repeat with a different `repeat_count` → 200, row unchanged; concurrent same `id` → one 201, one 200; new `id` after resolution → second open event; other company's `id` → 409 revealing nothing; `repeat_count` 0, oversized `detail`, array `detail` → 422; `occurred_at` a day ahead clamped; event during a pause stored; repeat lists one event

## 2. alerts-feed

- [ ] 2.1 `GET /v1/alerts` with role scoping (manager: `employees.manager_user_id` of the device's employee), filters and cursor
- [ ] 2.2 `POST /v1/alerts/:id/resolve` for `company_admin` and `it_admin`, idempotent
- [ ] 2.3 Tests: manager sees only own team; manager resolve → 403; resolved tamper clears `tamper` status; staff → 403; tenant isolation: another company's event never listed and resolve → 404
- [ ] 2.4 Cursor on `(occurred_at, id)`; `null` next cursor on the last page; resolve with `UPDATE … WHERE resolved_at IS NULL` so the first resolver wins
- [ ] 2.5 Tests (edge cases): employee moved to another manager moves events to the new manager's feed; a released binding's events stay with its employee, never the next binding's; empty feed; released device's event listed with snapshot hostname; ties across a page break neither repeat nor skip; full last page → `null` cursor; reversed dates → 422; other company's `device_id` → empty; concurrent resolves keep the first `resolved_by`; one of two open events resolved → still `tamper`

