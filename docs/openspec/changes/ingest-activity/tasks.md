> **Read first — this task list is not the requirement.**
> Capabilities: `activity-ingestion · screenshot-upload · screenshot-access`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show ingest-activity`.
> Contract: [agent-contract.md](../../../core/api/agent-contract.md) · Schema: [data-model.md](../../../core/architecture/data-model.md).

## 1. Schema

- [x] 1.1 `db/migrations/0002_spec_gaps.sql` adding `ingest_batches.body_sha256 text NOT NULL` with its self-check (the body hash for `409 IDEMPOTENCY_KEY_REUSED`)

## 2. activity-ingestion

- [ ] 2.1 Batch zod schema and body limit in `packages/shared`; `Idempotency-Key` = `batch_id` check
- [ ] 2.2 One transaction: insert `ingest_batches` first (conflict → compare `body_sha256`, return stored `counts` or 409), then bulk insert the four arrays
- [ ] 2.3 Stamp `company_id`, `device_id`, `employee_id` from the uploading key's binding (released keys included, D45), never by timestamp; `session_user` → `os_user`; Unix ms → `timestamptz`
- [ ] 2.4 B7 window filter and `dropped_out_of_window`; `activity_buckets` upsert on `(device_id, bucket_start)`
- [ ] 2.5 Tests: repeat → same counts, no new rows; concurrent duplicates → one copy; changed body → 409; skewed records dropped and counted; empty arrays accepted; invalid record → 422 and nothing written; body `company_id` ignored
- [ ] 2.6 Collapse repeated `bucket_start` within a batch to the last row before the upsert (one statement cannot touch a row twice)
- [ ] 2.7 Edge tests: retry after a 5xx stores once; missing or mismatched `Idempotency-Key` → 400; 409 leaves the first records; same `batch_id` on two devices, same and different company → both accepted; window edge kept; all-dropped batch → 200 and `ingest_batches` written; resend after the 14-day cleanup → all dropped; four empty arrays → all-zero counts; later bucket replaces samples; `active_samples` = `total_samples` and zero-length session valid; record inside a pause stored; duplicate bucket in one batch → last wins, counted once; 402 then restore → accepted once; released key at day 2 → stored under the released binding and its employee; released key at day 8 → 401 `DEVICE_RELEASED` and nothing written; released binding's upload after a new binding on the same `hardware_id` → zero rows under the new binding

## 3. screenshot-upload

- [ ] 3.1 Private bucket `screenshots`: `image/jpeg` only, file size limit from `packages/shared`
- [ ] 3.2 `POST /v1/agents/screenshots`: insert pending row, signed upload URL to `{company_id}/{device_id}/{id}.jpg`
- [ ] 3.3 Repeat handling: fresh URL while pending, uploaded state, 409 on a different body or device
- [ ] 3.4 `POST /v1/agents/screenshots/:id/confirm`: object stat, size check, delete on mismatch
- [x] 3.8 Optional thumbnail: `thumb_bytes` → `thumb_upload_url` for `{id}.thumb.jpg`, never a refusal; confirm keeps it only when whole; `thumb_url` in the timeline; migration `0011_screenshot_thumbnails.sql`
- [ ] 3.5 Tests: request → PUT → confirm; repeat before and after confirm; missing object → 422 stays pending; another device's ID → 409; logs hold no signed URL or path
- [ ] 3.6 Edge tests: concurrent requests → one row, 201 + 200; repeat after confirm → `upload_url` null; another device's or company's ID → 409, no path leaked; changed `bytes` → 409; confirm before PUT → 422 then 200 after it; concurrent confirms → `uploaded_at` once; mis-sized → new URL, then 200; another device confirms → 404; `bytes` at the limit → 201; `captured_at` 9 days old → 422; `employee_id` from the binding and kept when the device is released before confirm; released key confirms inside 7 days → 200, after → 401 `DEVICE_RELEASED`

## 4. screenshot-access

- [ ] 4.1 `GET /v1/employees/:id/screenshots?date=` for `company_admin` and the employee's manager, 5-minute signed view URLs
- [ ] 4.2 Tier `off` → `screenshots_enabled` false, no URLs
- [ ] 4.3 Tests: IT admin and staff → 403; manager of another team → 404; tenant isolation: another company's employee → 404 and no URL issued; pending rows never listed
- [ ] 4.4 Day bounds from `companies.timezone`; `date` validated (400 on missing, malformed, impossible)
- [ ] 4.5 Edge tests: device released and set up for another employee splits the day by each record's `employee_id`; B's manager cannot get a `view_url` for A's binding's screenshot; archived employee listed; only-pending day → empty, no URL; `expires_at` = signing + 5 min; former manager → 404; tier back on lists old screenshots; 23:59 / 00:00 local split; `2026-02-30` → 400
