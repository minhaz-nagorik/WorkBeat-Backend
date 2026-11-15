## Context

`/cron/cleanup` deletes a day of every company's activity, millions of rows at the 5,000-device
load test, and deletes Storage objects that a database rollback cannot bring back.

## Decisions

### Cleanup commits in batches, not in one request transaction
Amends: B2 ("each request runs in one transaction"), for `/cron/cleanup` only. One transaction
over millions of deletes holds locks and a pooled connection for minutes on the transaction-mode
pooler, and a failure near the end throws all of it away. data-model.md §7 already says "batched
deletes". Each batch is its own short transaction that sets `app.scope` = `system` first, so the
B2 guarantee (no query without a scope) still holds per transaction. Deletes are idempotent, so a
run cut short loses nothing.

### The job lock is a transaction advisory lock taken by every transaction of a run
Session advisory locks are unsafe on the transaction-mode pooler. Every transaction of a run
calls `pg_try_advisory_xact_lock` for its job; when it is held, the run stops and answers
`skipped`. Two overlapping cleanups can at worst interleave batches, which is harmless.

### A run stops at a time budget
A run deletes batch after batch until nothing is left or the budget in `packages/shared` is
spent, then answers `more: true`. A backlog (a company lowering retention from 365 to 30 days)
finishes over the following nights or by calling the route again; no in-process loop.

### Storage objects are deleted before their rows
A row without an object shows a missing screenshot and is deleted next run; an object without a
row is never found again. Rows whose object delete failed are kept for the next run.
