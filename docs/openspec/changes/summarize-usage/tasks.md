> **Read first — this task list is not the requirement.**
> Capabilities: `usage-summaries`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show summarize-usage`.

## 1. Schema

- [x] 1.1 `db/migrations/0010_usage_summaries.sql`: `usage_days`, `usage_hours`, `usage_apps`, `usage_domains`; tenant RLS; self-check in `db/tests/`

## 2. Job

- [x] 2.1 Cron guard and runner (`run-scheduled-jobs` 2.1, 2.2)
- [x] 2.2 `POST /cron/usage-summary`: delete past retention, build unmarked finished days newest first, budget and `more`
- [x] 2.3 Scheduler entry, hourly, in `docs/operations/scheduled-jobs.md`

## 3. Readers and writers

- [x] 3.1 `daily()`, ranked apps and websites, activity totals and hours read summaries for marked days and raw rows for the rest
- [x] 3.2 Ingest rebuilds the employee-day of a late batch under the per-day lock
- [x] 3.3 A timezone change deletes the company's summaries

## 4. Tests

- [x] 4.1 Smoke: every report gives the same response before and after the job; a late batch shows at once; no secret → 401
- [ ] 4.2 DB self-check run against a real database (`db/tests/0010_usage_summaries_test.sql`)
- [ ] 4.3 Load test: 100 employees × 90 days, a 90-day productivity report before and after summaries
