> **Read first — this task list is not the requirement.**
> Capabilities: `tamper-ingestion · alerts-feed · alert-emails`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show process-tamper-alerts`.
> Contract: [agent-contract.md](../../../core/api/agent-contract.md) · Schema: [data-model.md](../../../core/architecture/data-model.md).

## 1. tamper-ingestion

- [ ] 1.1 Tamper zod schema in `packages/shared`: five event types, `repeat_count` ≥ 1, `detail` object with a size limit
- [ ] 1.2 `POST /v1/agents/tamper`: insert with hostname snapshot; on `id` conflict, a visible row of the same device and type → 200; anything else, including a row hidden by RLS → 409
- [ ] 1.3 Clamp a future `occurred_at` to server time; no B7 window
- [ ] 1.4 Hand the new event to `alert-emails` after commit
- [ ] 1.5 Tests: repeat → 200 and one row; other device's `id` → 409; `offline` → 422; ten-day-old event stored; `402` during suspension writes nothing
- [ ] 1.6 Tests (edge cases): repeat with a different `repeat_count` → 200, row unchanged; concurrent same `id` → one 201, one 200; new `id` after resolution → second open event; other company's `id` → 409 revealing nothing; `repeat_count` 0, oversized `detail`, array `detail` → 422; `occurred_at` a day ahead clamped; event during a pause stored; repeat hands over no second alert

## 2. alerts-feed

- [ ] 2.1 `GET /v1/alerts` with role scoping (manager: `employees.manager_user_id` of the device's employee), filters and cursor
- [ ] 2.2 `POST /v1/alerts/:id/resolve` for `company_admin` and `it_admin`, idempotent
- [ ] 2.3 Tests: manager sees only own team; manager resolve → 403; resolved tamper clears `tamper` status; staff → 403; tenant isolation: another company's event never listed and resolve → 404
- [ ] 2.4 Cursor on `(occurred_at, id)`; `null` next cursor on the last page; resolve with `UPDATE … WHERE resolved_at IS NULL` so the first resolver wins
- [ ] 2.5 Tests (edge cases): reassigned employee moves events to the new manager's feed; empty feed; released device's event listed with snapshot hostname; ties across a page break neither repeat nor skip; full last page → `null` cursor; reversed dates → 422; other company's `device_id` → empty; concurrent resolves keep the first `resolved_by`; one of two open events resolved → still `tamper`

## 3. alert-emails

- [ ] 3.1 Recipient resolver from `companies.alert_email` (roles, types), skipping disabled users, scoping managers
- [ ] 3.2 Resend templates for one event and for a digest, holding no `detail`, URL or title
- [ ] 3.3 Instant send after commit; set `emailed_at`
- [ ] 3.4 `/cron/alert-digest` hourly: hourly companies, daily companies in the run inside the 09:00 local hour of `companies.timezone`, retry failed instant sends < 24 h old
- [ ] 3.5 Tests: unselected type not emailed; manager of another team not emailed; Resend failure retried once by the digest; `emailed_at` prevents a second email; email body has no `detail`; tenant isolation: a digest never lists another company's events
- [ ] 3.6 Digest window: unemailed events < 24 h (hourly) or < 48 h (daily), newest first; events past 24 h dropped from instant retry and logged by event ID; every recipient resent on a partial failure
- [ ] 3.7 Tests (edge cases): no recipient → `emailed_at` set, no email; manager role but no manager → no email; disabled user excluded; instant failure then switch to daily → sent once in the digest; no events → no digest; `Asia/Kolkata` daily at 03:30 UTC; `America/New_York` DST day → one digest; overlapping digest run → `skipped`; partial recipient failure → resent to all; 30-hour outage → not emailed after 24 h; two missed hourly runs caught up by the next; missed daily run caught up next day; subject has only type and hostname
