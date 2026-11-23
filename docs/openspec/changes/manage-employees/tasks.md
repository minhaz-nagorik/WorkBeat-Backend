> **Read first — this task list is not the requirement.**
> Capabilities: `employee-directory · manager-teams · monitoring-settings · monitoring-pauses`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show manage-employees`.
> Contract: [agent-contract.md](../../../core/api/agent-contract.md) · Schema: [data-model.md](../../../core/architecture/data-model.md).

## 1. employee-directory

- [ ] 1.1 zod schemas in `packages/shared` for employee create/update, list query (`archived`) and import result; codes `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `EMPLOYEE_HAS_DEVICES`
- [ ] 1.2 `GET/POST /v1/employees`, `GET/PATCH/DELETE /v1/employees/:id`; unique-email violation → `409 CONFLICT`
- [ ] 1.3 `DELETE` sets `archived_at`; map the trigger's `EMPLOYEE_HAS_DEVICES` exception to `409`
- [x] 1.4 `POST /v1/employees/import`: CSV parser (optional header, four columns), in-file duplicate check, one transaction, 500-row limit; existing email → `email_exists`; per-row `invalid` reasons; `POST /v1/employees/import/check` (read-only)
- [ ] 1.5 Tests: role matrix per route; duplicate email → 409; archive with an unreleased device → 409, after release → archived; import refuses an existing email (`email_exists`) and writes nothing on one bad row; `import/check` writes nothing and never waits for approval; tenant isolation — another company's employee ID → 404 and never listed
- [ ] 1.6 CSV parser: strip a UTF-8 BOM, accept CRLF, RFC 4180 quoting; empty or header-only file → 422; case-insensitive in-file duplicate check; manager email must be an enabled `manager`
- [ ] 1.7 Archived employee is read-only: PATCH, settings PUT and pause writes → `409 CONFLICT`; archive takes the employee row lock that enrollment also takes (`FOR SHARE`), so archive and enroll serialise
- [ ] 1.8 Tests (edge cases): case-only duplicate email → 409; concurrent same-email creates → one 201, one 409; blank name → 422; `company_id` in body ignored; several employees without email; BOM + CRLF file; quoted comma; archived email re-created on import; duplicate emails in file → 422 naming both lines; unknown or disabled manager email → 422; 0 rows → 422; exactly the cap → imported, cap + 1 → 413; two concurrent imports of one file → no duplicate; unreleased binding blocks archive → 409, released binding does not; repeat archive keeps `archived_at`; archive vs enroll race
- [ ] 1.9 `POST /v1/employees/:id/restore`: clear `archived_at`, optional `email`; unique-email violation → `409 CONFLICT`; no email → `422`; import refuses a row whose email only an archived employee holds, with `archived: [{ line, employee_id, name }]`
- [ ] 1.10 Tests: restore → same `id`, editable again, back in totals; email held by another → 409 and still archived; restore with a new email; not archived → 200 unchanged; it_admin/manager → 403; other company → 404; import of an archived email → 422 naming the line
- [x] 1.11 Presence per online device: `last_input_at` within the idle threshold of the latest heartbeat, else (no `last_input_at`) an active bucket of that device in the last 35 minutes; any active device makes the employee `active` (19 Nov 2026)

## 2. manager-teams

- [ ] 2.1 Manager validation: user with role `manager`, same company, not disabled → else `422`
- [ ] 2.2 Team filter (`manager_user_id = caller`) applied in the employee query layer for role `manager`, reusable by later changes
- [ ] 2.3 Tests: manager lists only their team; other team → 404; every write route → 403 for a manager; tenant isolation — a manager of company A assigned in company B is refused
- [ ] 2.4 Tests (edge cases): disabled manager → 422; employee ID as `manager_user_id` → 422; clear to null; moving an employee to another manager moves visibility at once; manager `archived=true` sees own team only; manager import → 403 before parsing; assign vs remove race ends with no manager or an enabled one (lock the `users` row while validating)

## 3. monitoring-settings

- [ ] 3.1 `GET/PUT /v1/employees/:id/monitoring-settings`; `updated_by` from the user
- [ ] 3.2 Interval rule (B11) against `tier_interval(licenses.screenshot_tier)`
- [ ] 3.3 Tests: settings row exists after create and import with tier defaults; tier rule matrix (off, light, standard, intensive × 0/600/1800/3600); `policy_version` rises on every `PUT`; `notice_version` unchanged; tenant isolation — another company's employee → 404
- [ ] 3.4 Read the tier with `FOR SHARE` on the `licenses` row in the settings `PUT`, so a tier-lowering event serialises with it
- [ ] 3.5 Tests (edge cases): tier `off` on create → 0; import creates settings for each row; 900 and -1 → 422; exactly the tier interval accepted; tier `off` with switches only accepted; concurrent PUT 600 and tier → `light` ends at 3600 or 0; manager PUT → 403 and no version bump

## 4. monitoring-pauses

- [ ] 4.1 `GET/POST /v1/employees/:id/pauses`, `PATCH /v1/employees/:id/pauses/:pause_id`, `POST …/cancel`
- [ ] 4.2 Overlap check under a row lock on the employee's settings row, so two concurrent creates cannot both pass
- [ ] 4.3 Derived `status` from `starts_at`, `ends_at`, `cancelled_at` and the server clock
- [ ] 4.4 Tests: past start → 422; overlap → 409 (create and extend); cancel/extend an ended pause → 409; each change raises `policy_version`; manager reads, cannot write; it_admin → 403; tenant isolation — another company's pause ID → 404
- [ ] 4.5 Clock tolerance constant in `packages/shared`; a `starts_at` within it is set to the server time; `PATCH` accepts only `ends_at`; map the exclusion-constraint violation to `409 CONFLICT`
- [ ] 4.6 Tests (edge cases): start within tolerance → server time; end in the past → 422; back-to-back pauses allowed; cancelled pause does not block; extend into the next pause → 409; concurrent overlapping creates → one 201, one 409; cancel after end → 409; cancel twice → 409, first `cancelled_at` kept; cancel a scheduled pause; shorten into the past → 422; pause ID of another employee → 404; refused change leaves `policy_version`; `status` at `starts_at` and `ends_at`
- [x] 4.7 B29: `GET /v1/employees/:id/monitoring-settings` returns `screenshot_tier`, so the console limits intervals without reading billing
