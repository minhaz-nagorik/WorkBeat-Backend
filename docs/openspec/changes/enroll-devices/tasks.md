> **Read first — this task list is not the requirement.**
> Capabilities: `license-validation · device-enrollment · device-authentication · device-lifecycle`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show enroll-devices`.
> Contract: [agent-contract.md](../../../core/api/agent-contract.md) · Schema: [data-model.md](../../../core/architecture/data-model.md) · Amendments: [design.md](design.md).

## 1. license-validation

- [ ] 1.1 zod schemas in `packages/shared` for the validate request (`employee_id` optional) and both responses
- [ ] 1.2 Licence-key guard: SHA-256 → `auth_license` → tenant scope; company status → `402` codes
- [ ] 1.3 Seat check from the `devices_seat` count (read only, no lock held after the request)
- [ ] 1.4 Step 2: random token, `token_hash`, `expires_at` = now + 24 h, `license_id`; token returned once, never logged
- [ ] 1.5 Tests: unknown and pre-reissue key → 404; suspended → 402 `LICENSE_SUSPENDED`; expired → 402 `LICENSE_EXPIRED`; full → 403 at both steps; step 1 writes nothing; archived employee → 404 `EMPLOYEE_NOT_FOUND`; tenant isolation — the list never carries another company's employees and another company's `employee_id` → 404
- [ ] 1.6 Edge tests: no header with a body key → 404; suspended between steps → 402 and no token; `trial` served; released devices free seats; NULL `seat_limit` never 403; empty employee list; step 2 twice → two usable tokens; employee archived between steps → 404; newest release withdrawn → older `package_url`; unknown `os` / `arch` → 400 and no token

## 2. device-enrollment

- [ ] 2.1 Enrollment-token guard: SHA-256 → `auth_enrollment_token`; tenant-scope read of `used_at` / `expires_at` for the exact 403 code
- [ ] 2.2 One transaction: lock the token row (`used_at IS NULL`), find the live binding by `(company_id, hardware_id) WHERE released_at IS NULL`; none → insert (new binding); same `employee_id` → new key on that row (same binding); other `employee_id` → `409 DEVICE_ASSIGNED` and roll back; set `used_at`
- [ ] 2.2a Response `outcome` (`new_binding` | `same_binding`) and `notice_required` (true / false) in the `packages/shared` schema
- [ ] 2.2b Same binding whose replaced key heartbeated in the last 15 minutes → insert a server-made `duplicate_device_id` `tamper_events` row in the same transaction
- [ ] 2.3 Map the trigger's `SEAT_LIMIT_EXCEEDED` to `403`; the transaction rolls back so the token stays unused
- [ ] 2.4 Device key: random, returned once, stored as `key_hash` only, never logged
- [ ] 2.5 Tests: new binding → `new_binding`, `notice_required` true; same binding keeps `device_id` and seat count, revokes the old key, `same_binding`, `notice_required` false; live binding of another employee → 409 `DEVICE_ASSIGNED`, no row changed, old key works, token unused; released hardware → new binding; body `employee_id` mismatch → 422; concurrent use of one token → one 201, one 403; tenant isolation — a token of company A never reuses a row of company B with the same `hardware_id`
- [ ] 2.6 Edge tests: used and expired → `EXHAUSTED`; at `expires_at` → `EXPIRED`; retry after a lost 201 → 403 and a new token reuses the row with no second seat; two tokens race for the last seat → one 201, one 403, count never over the limit; suspended after issue → 402, token still usable after restore; omitted body `employee_id` → token's; employee archived before enroll → 404, token unused; same `hardware_id` concurrently → one row, last key wins, one seat; re-enroll for another employee while live → 409 and `employee_id` unchanged; release then enroll for another employee → new row, released row keeps its employee; new `hardware_id` after reinstall → second binding and seat; re-enroll with the old key heartbeated 5 min ago → one `duplicate_device_id` event, 40 min ago → none; released + live rows → live kept; malformed body → 400, token unused; unknown token + bad body → 404

## 3. device-authentication

- [ ] 3.1 Device-key guard for `/v1/agents/*`
- [ ] 3.2 Order: key → released (upload routes inside 7 days of `released_at` pass on as the released binding; every other route `401 DEVICE_RELEASED` with `released_at`, `upload_until`) → company status (`suspended` → `COMPANY_SUSPENDED`, `expired` → `LICENSE_EXPIRED` + `blocking_ends_at`) → tenant scope
- [ ] 3.3 Tests: unknown, missing and replaced key → 401 `DEVICE_REVOKED`, never 404; released heartbeat → 401 `DEVICE_RELEASED` with `upload_until` = `released_at` + 24 h; released key on activity / screenshots / confirm at day 2 → stored under the released binding and its employee, at day 8 → 401 `DEVICE_RELEASED`; suspended heartbeat → 402; `blocking_ends_at` arithmetic; tenant isolation — body `device_id` / `company_id` ignored
- [ ] 3.4 Edge tests: new key works after the old one is refused; no header → 401 not 404; released beats suspended; `blocking_ends_at` unchanged after the grace; query `company_id` ignored

## 4. device-lifecycle

- [ ] 4.1 `POST /v1/devices/:id/release`
- [x] 4.2 No deactivate route (B35): `POST /v1/devices/:id/deactivate` → 404 for a user token and a device key
- [ ] 4.3 No route writes `devices.employee_id` after insert; the `devices_employee_fixed` trigger (0003) refuses it
- [ ] 4.4 Tests: role matrix (company_admin, it_admin allowed; manager 403); seat freed by release; release keeps the key and answers `DEVICE_RELEASED`; `UPDATE devices SET employee_id` refused by the database; release then Setup for another employee → new row, released row's records keep their `employee_id`; tenant isolation — another company's device → 404
- [x] 4.6 `POST /v1/agents/uninstall` (B36): released_at if unset, uninstalled_at, key cleared, 204; released key accepted at any age; no 402; migration 0019 (`devices_uninstalled_is_released`); status `uninstalled`, `?status=uninstalled`, rollout count
- [ ] 4.7 Tests: uninstall → 204, seat freed, heartbeat and repeat → 401 `DEVICE_REVOKED`; uninstall after release keeps `released_at`; suspended company → 204; another device's key never changes this device
- [ ] 4.5 Edge tests: release a released device → 409; manager → 403; lifecycle routes delete no activity, screenshot, tamper or acknowledgement row
