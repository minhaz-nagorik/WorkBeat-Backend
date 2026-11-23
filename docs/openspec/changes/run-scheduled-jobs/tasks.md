> **Read first — this task list is not the requirement.**
> Capabilities: `cron-routes · data-retention`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show run-scheduled-jobs`.
> Contract: [agent-contract.md](../../../core/api/agent-contract.md) · Schema: [data-model.md](../../../core/architecture/data-model.md).

## Status (19 Nov 2026)

**Built:** `/cron/cleanup` (`apps/api/src/cleanup.ts`): partitions ahead, each company's activity
past retention, `ingest_batches` > 14 days, resolved tamper events past retention, partitions past
90 days. Checked by `pnpm smoke:cleanup` against a local `_test` database (all checks passed) and
through the HTTP route (401 without the secret, 200 with it). systemd timers for `usage-summary`
and `cleanup` in `db/cron/`.

**Not running anywhere yet:** install the timers on one server and set `CRON_SECRET` in the API
(`db/cron/README.md`).

**Left:** 2.5–2.6 cron-route tests, 3.2 screenshot rows and R2 files (deferred),
3.5 load test, the rest of 3.7 (see 4.3), 4.1 tables with no retention rule, 4.2 partition time zone.

## 1. Schema

- [x] 1.1 `db/migrations/0002_spec_gaps.sql`: `ensure_month_partitions()` and `drop_old_partitions()` become `SECURITY DEFINER`, refuse unless `app_scope() = 'system'`, `EXECUTE` granted to `workbeat_api` only; self-check in `db/tests/`

## 2. cron-routes

- [x] 2.1 Cron guard: `X-Cron-Secret` vs. the configured secret with `crypto.timingSafeEqual`; 401 `UNAUTHENTICATED` otherwise; header in the log redaction list
- [x] 2.2 Job runner: `system` scope per transaction, `pg_try_advisory_xact_lock(hashtext('cron:<job>'))`, response `{ job, started_at, duration_ms, rows_affected, skipped, more }`, one log line
- [x] 2.3 `POST /cron/token-expiry` — Done: `apps/api/src/token-expiry.ts`, timer `db/cron/workbeat-cron@token-expiry.timer`; `pnpm smoke:token-expiry` covers deletes across companies, used and unexpired kept, lock held → skipped, run twice = once, nothing to delete → empty
- [x] 2.4 Schedule definitions (server cron or systemd timers calling `curl` with the secret from the environment) for all three jobs, in `db/cron/` and the deploy guide — Done: systemd timers for `usage-summary`, `token-expiry` and `cleanup` in `db/cron/`
- [ ] 2.5 Tests: no / wrong secret / user JWT → 401 and nothing runs; second concurrent call → `skipped`; run twice = run once; used tokens survive token-expiry; no route outside `/cron/*` can set `system` scope
- [ ] 2.6 Tests (edge cases): unknown job with valid secret → 404; secret prefix (different length) → 401 without throwing; secret in query → 401; old secret after rotation → 401; every batch transaction sets `system` scope with no company; two same-second calls → one `skipped`; two different jobs never skip each other; failed run then retry writes nothing twice; run longer than its interval → next call `skipped`; skipped run response and log line; token at exactly `expires_at` kept; no tokens → 0

## 3. data-retention

- [x] 3.1 `POST /cron/cleanup`: partitions, per-company batched deletes of the four activity tables, time budget and `more`
- [ ] 3.2 Screenshot sweep: Storage delete first (batched), then rows; failed objects keep their rows — **deferred (product owner, 19 Nov 2026)**: cleanup leaves `screenshots` rows and R2 files untouched until this lands, so the row keeps the only record of each file's path
- [x] 3.3 `ingest_batches` > 14 days, resolved `tamper_events` past retention, `cron_drop_old_partitions(90)`
- [x] 3.4 Tests (`pnpm smoke:cleanup`, a `_test` database; the Storage parts wait for 3.2): two companies with 30 and 90 days — each keeps its own window (tenant isolation); released device follows retention; Storage failure keeps the row; open tamper event kept; `notice_acknowledgements` never deleted; budget spent → `more` and the next run finishes
- [ ] 3.5 Load test: one night's cleanup on the 5,000-device data set finishes within the budget
- [x] 3.6 Delete oldest first per company, cut-off fixed at the run's start time, retention read per company at run start
- [ ] 3.7 Tests (edge cases; done in `smoke:cleanup`: existing partition no-op, 90 → 30 backlog, 30 → 90, ±1 min of the cut-off instead of 1-day retention, `ingest_batches` 13/15 days, old resolved tamper event, partition partly inside 90 days, run twice = once, held lock → skipped; rest in 4.3): December run creates Nov–Feb; existing partition is a no-op; 90 → 30 backlog returns `more` and finishes over runs; 30 → 90 deletes nothing new; row exactly at the cut-off kept; 1-day retention; suspended and expired companies follow retention; Storage fully down keeps all screenshot rows and still cleans activity; missing object counted; `ingest_batches` exactly 14 days kept; old resolved tamper event deleted; partition partly inside 90 days kept; nothing to drop → 0; run killed after N batches resumes; kill between object and row delete resumes; two overlapping runs delete no row twice

## Open (found 19 Nov 2026)

- [ ] 4.1 Tables with no retention rule and not on the "never deleted" list: `sessions`, `password_resets`, `mfa_challenges`, `invitations`, `monitoring_pauses`, used `enrollment_tokens`, `stripe_events`, `changes`. Decide each (product owner: later change)
- [ ] 4.2 `ensure_month_partitions()` turns month dates into bounds with the session `TimeZone` (`m::timestamptz`), so a non-UTC server makes partitions start at local midnight, and a later run under another `TimeZone` would leave gaps or overlaps. Fix with a migration that builds bounds `AT TIME ZONE 'UTC'` and handles existing partitions
- [ ] 4.3 Edge-case tests still to write from 3.7: December run creates Nov–Feb (needs a controllable clock), run killed after N batches, Storage cases (with 3.2)
