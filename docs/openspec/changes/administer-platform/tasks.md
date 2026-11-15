> **Read first — this task list is not the requirement.**
> Capabilities: `staff-companies · staff-license-reissue · staff-data-boundary`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show administer-platform`.
> Contract: [agent-contract.md](../../../core/api/agent-contract.md) · Schema: [data-model.md](../../../core/architecture/data-model.md).

## 1. staff-companies

- [x] 1.1 `db/migrations/0002_spec_gaps.sql`: `company_seat_counts() RETURNS TABLE (company_id uuid, seats_used int)`, `SECURITY DEFINER`, executable only when `app_scope()` is `staff` or `system`, granted to `workbeat_api`; self-check in `db/tests/0002_*_test.sql`
- [ ] 1.2 `GET /v1/staff/companies` (filter by status, search by name or slug, paging) and `GET /v1/staff/companies/:id`; tier add-on prices in `packages/shared` for the MRR estimate
- [ ] 1.3 `POST /v1/staff/companies/:id/suspend`, `POST /v1/staff/companies/:id/restore`, `PATCH /v1/staff/companies/:id`, `PATCH /v1/staff/companies/:id/license`
- [ ] 1.4 Tests: suspend → `staff` reason, then `invoice.paid` does not restore; restore of an `expired` company → 409; seat limit below seats used → 409; seat limit on Growth → 409; grace change moves `blocking_ends_at`; tenant isolation: the list's seat counts match each company's own devices and nothing else
- [ ] 1.5 Lock the `companies` row (`FOR UPDATE`) in suspend, restore and every Stripe status handler; escape `%` and `_` in search
- [ ] 1.6 Tests (edge cases): literal `%`/`_` search; unknown ID → 404; 0 seats → MRR 0; staff suspend over `payment_failed` → `staff`; suspend twice keeps `suspended_at`; restore after trial end → `active`; restore of an active company unchanged; suspend vs `invoice.paid` race ends `staff`; `seat_limit` = seats used accepted and next enrollment refused; Growth `seat_limit` → 409; null → unlimited; grace 0/365 saved, 366 → 422; grace shortened into the past

## 2. staff-license-reissue

- [x] 2.1 `db/migrations/0002_spec_gaps.sql`: `delete_unused_enrollment_tokens(p_license_id uuid) RETURNS int`, `SECURITY DEFINER`, deleting only rows with `used_at` NULL; self-check
- [ ] 2.2 `POST /v1/staff/companies/:id/license/reissue`: new key, hash, ciphertext, last4, `key_reset_at`, token delete, one transaction; email to every enabled company admin after commit
- [ ] 2.3 Tests: 50/50 seats on key A → 50/50 on key B; old key → `/license/validate` 404 `LICENSE_NOT_FOUND`; an unused token → `/devices/enroll` 404 `ENROLLMENT_TOKEN_INVALID`; enrolled devices keep working; neither key is logged; tenant isolation: reissuing company A leaves company B's key and tokens untouched
- [ ] 2.4 Reissue takes `FOR UPDATE` on the `licenses` row; `/license/validate` takes `FOR SHARE` before inserting a token, so no token of the old key survives
- [ ] 2.5 Tests (edge cases): two reissues → only the second key works; reissue of suspended or expired company keeps `status`; validate in flight during reissue; no tokens → succeeds; Resend down → reissue committed, failure logged; no enabled admin → no email

## 3. staff-data-boundary

- [ ] 3.1 Allow-list of tables per scope checked by a repository guard; staff response schemas in `packages/shared` with no employee or device field
- [ ] 3.2 CI test: a `super_admin` token calls every staff route and every company route; staff routes return no employee, device, activity, URL or screenshot field or value, company routes answer 403
- [ ] 3.3 CI test: in `staff` scope, `SELECT` on every tenant table returns zero rows, and `company_seat_counts()` returns only `company_id` and `seats_used`
- [ ] 3.4 Tests: seed two companies with employees and devices; no name, hostname, URL or screenshot path of either appears in any staff response
- [ ] 3.5 Tests (edge cases): staff code setting `system` scope fails with 500; staff error bodies hold no tenant value; staff `SELECT` filtered by a real `company_id` still returns zero rows
