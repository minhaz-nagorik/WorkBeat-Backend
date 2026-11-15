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
- [ ] 1.6 Edge tests: no header with a body key → 404; suspended between steps → 402 and no token; `trial` served; released and deactivated devices free seats; NULL `seat_limit` never 403; empty employee list; step 2 twice → two usable tokens; employee archived between steps → 404; newest release withdrawn → older `package_url`; unknown `os` / `arch` → 400 and no token

## 2. device-enrollment

- [ ] 2.1 Enrollment-token guard: SHA-256 → `auth_enrollment_token`; tenant-scope read of `used_at` / `expires_at` for the exact 403 code
- [ ] 2.2 One transaction: lock the token row (`used_at IS NULL`), upsert the device by `(company_id, hardware_id) WHERE released_at IS NULL`, set `used_at`
- [ ] 2.3 Map the trigger's `SEAT_LIMIT_EXCEEDED` to `403`; the transaction rolls back so the token stays unused
- [ ] 2.4 Device key: random, returned once, stored as `key_hash` only, never logged
- [ ] 2.5 Tests: new row; reuse keeps `device_id` and seat count and revokes the old key; deactivated reuse at a full company → 403; released hardware → new row; body `employee_id` mismatch → 422; concurrent use of one token → one 201, one 403; tenant isolation — a token of company A never reuses a row of company B with the same `hardware_id`
- [ ] 2.6 Edge tests: used and expired → `EXHAUSTED`; at `expires_at` → `EXPIRED`; retry after a lost 201 → 403 and a new token reuses the row with no second seat; two tokens race for the last seat → one 201, one 403, count never over the limit; suspended after issue → 402, token still usable after restore; omitted body `employee_id` → token's; employee archived before enroll → 404, token unused; full-company deactivated reuse leaves the row deactivated; same `hardware_id` concurrently → one row, last key wins, one seat; re-enroll for another employee raises `policy_version`; released + active rows → active reused; malformed body → 400, token unused; unknown token + bad body → 404

## 3. device-authentication

- [ ] 3.1 Device-key guard for `/v1/agents/*` and `POST /v1/devices/:id/deactivate` without a user token
- [ ] 3.2 Order: key → released → company status (`suspended` → `COMPANY_SUSPENDED`, `expired` → `LICENSE_EXPIRED` + `blocking_ends_at`) → tenant scope
- [ ] 3.3 Tests: unknown, missing, replaced and deactivated key → 401 `DEVICE_REVOKED`, never 404; released → 401 `DEVICE_RELEASED`; suspended heartbeat → 402; `blocking_ends_at` arithmetic; tenant isolation — body `device_id` / `company_id` ignored
- [ ] 3.4 Edge tests: new key works after the old one is refused; no header → 401 not 404; released beats suspended; released uninstaller → 401 `DEVICE_RELEASED`, nothing written; `blocking_ends_at` unchanged after the grace; query `company_id` ignored; deactivate with a key past `blocking_ends_at` → 204

## 4. device-lifecycle

- [ ] 4.1 `POST /v1/devices/:id/deactivate` (user token or device key), `/release`, `/reassign`
- [ ] 4.2 Deactivate: `deactivated_at`, `key_hash` NULL in one update; idempotent
- [ ] 4.3 Reassign: active employee of the company; trigger raises `devices.policy_version`
- [ ] 4.4 Tests: role matrix (company_admin, it_admin allowed; manager 403); uninstaller with another `:id` → 403; seat freed by deactivate and release; release keeps the key and answers `DEVICE_RELEASED`; reassign to null → 400, archived → 404; earlier activity keeps its `employee_id`; tenant isolation — another company's device → 404
- [ ] 4.5 Edge tests: deactivate twice → 200, first `deactivated_at` kept; deactivate or release a released device → 409; uninstaller repeat → 401 `DEVICE_REVOKED`; another `:id` changes neither device; reassign to archived or another company's employee → 404 `EMPLOYEE_NOT_FOUND`; same employee → 200 and no `policy_version` change; released → 409; deactivated → 200 and no seat; manager → 403; lifecycle routes delete no activity, screenshot, tamper or acknowledgement row
