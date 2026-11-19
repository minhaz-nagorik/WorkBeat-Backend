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
spent, then answers `more: true`. A backlog (a company lowering retention from 90 to 30 days)
finishes over the following nights or by calling the route again; no in-process loop.

### Storage objects are deleted before their rows
A row without an object shows a missing screenshot and is deleted next run; an object without a
row is never found again. Rows whose object delete failed are kept for the next run.

### Activity batches are one company day, not a row count (19 Nov 2026)
`/cron/cleanup` deletes activity one company day of one table per transaction, oldest first:
`DELETE … WHERE company_id = $1 AND <time> >= $day AND <time> < least($day + 1 day, cut-off)`. A row
count needs a row address, and `ctid` is not unique across partitions, while a time range lets
Postgres skip the other months' partitions and use the `(company_id, employee_id, <time>)` index.
`ingest_batches` and `tamper_events` are not partitioned and use `LIMITS.cleanupBatchRows` rows by
`ctid`. Cost: a day of a very large company is one bigger transaction; the load test (task 3.5)
decides whether hours are needed instead. The budget is `LIMITS.cleanupBudgetMs` (5 min) in
`apps/api/src/contract.ts`, where the shared constants live until `packages/shared` exists.

### Screenshots are not deleted until task 3.2 (product owner, 19 Nov 2026)
The first build of cleanup leaves `screenshots` rows and their R2 files alone. Deleting rows alone
would lose the only record of each file's path; rows and files go together when 3.2 is built.
