> **Read first — this task list is not the requirement.**
> Capabilities: `cron-routes · data-retention`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show run-scheduled-jobs`.
> Contract: [agent-contract.md](../../../core/api/agent-contract.md) · Schema: [data-model.md](../../../core/architecture/data-model.md).

## 1. Schema

- [x] 1.1 `db/migrations/0002_spec_gaps.sql`: `ensure_month_partitions()` and `drop_old_partitions()` become `SECURITY DEFINER`, refuse unless `app_scope() = 'system'`, `EXECUTE` granted to `workbeat_api` only; self-check in `db/tests/`

## 2. cron-routes

- [ ] 2.1 Cron guard: `X-Cron-Secret` vs. the configured secret with `crypto.timingSafeEqual`; 401 `UNAUTHENTICATED` otherwise; header in the log redaction list
- [ ] 2.2 Job runner: `system` scope per transaction, `pg_try_advisory_xact_lock(hashtext('cron:<job>'))`, response `{ job, started_at, duration_ms, rows_affected, skipped, more }`, one log line
- [ ] 2.3 `POST /cron/token-expiry`
- [ ] 2.4 Schedule definitions (server cron or systemd timers calling `curl` with the secret from the environment) for all five jobs, in `db/cron/` and the deploy guide
- [ ] 2.5 Tests: no / wrong secret / user JWT → 401 and nothing runs; second concurrent call → `skipped`; run twice = run once; used tokens survive token-expiry; no route outside `/cron/*` can set `system` scope
- [ ] 2.6 Tests (edge cases): unknown job with valid secret → 404; secret prefix (different length) → 401 without throwing; secret in query → 401; old secret after rotation → 401; every batch transaction sets `system` scope with no company; two same-second calls → one `skipped`; two different jobs never skip each other; failed run then retry writes nothing twice; run longer than its interval → next call `skipped`; skipped run response and log line; token at exactly `expires_at` kept; no tokens → 0

## 3. data-retention

- [ ] 3.1 `POST /cron/cleanup`: partitions, per-company batched deletes of the four activity tables, time budget and `more`
- [ ] 3.2 Screenshot sweep: Storage delete first (batched), then rows; failed objects keep their rows
- [ ] 3.3 `ingest_batches` > 14 days, resolved `tamper_events` past retention, `cron_drop_old_partitions(365)`
- [ ] 3.4 Tests: two companies with 30 and 90 days — each keeps its own window (tenant isolation); released device follows retention; Storage failure keeps the row; open tamper event kept; `notice_acknowledgements` never deleted; budget spent → `more` and the next run finishes
- [ ] 3.5 Load test: one night's cleanup on the 5,000-device data set finishes within the budget
- [ ] 3.6 Delete oldest first per company, cut-off fixed at the run's start time, retention read per company at run start
- [ ] 3.7 Tests (edge cases): December run creates Nov–Feb; existing partition is a no-op; 365 → 30 backlog returns `more` and finishes over runs; 30 → 90 deletes nothing new; row exactly at the cut-off kept; 1-day retention; suspended and expired companies follow retention; Storage fully down keeps all screenshot rows and still cleans activity; missing object counted; `ingest_batches` exactly 14 days kept; old resolved `offline` event deleted; partition partly inside 365 days kept; nothing to drop → 0; run killed after N batches resumes; kill between object and row delete resumes; two overlapping runs delete no row twice
