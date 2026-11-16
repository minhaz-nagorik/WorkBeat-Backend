> **Read first — this task list is not the requirement.**
> Capabilities: `user-authentication · role-access · team-invitations · staff-accounts`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show authenticate-users`.
> Contract: [agent-contract.md](../../../core/api/agent-contract.md) · Schema: [data-model.md](../../../core/architecture/data-model.md).

## 1. user-authentication

- [x] 1.1 `POST /v1/auth/login`, `/logout`, `/password`; scrypt hashes; `wbs_` session tokens stored hashed, 7 days; bearer guard through `auth_session` (B22, 0004)
- [x] 1.2 Cross-check against `users` (same role and company, `disabled_at` NULL); set the request scope from it (B2)
- [x] 1.3 `GET /v1/me` (with `company.timezone`)
- [ ] 1.4 Add `UNAUTHENTICATED`, `FORBIDDEN`, `MFA_CODE_INVALID`, `PASSWORD_RESET_INVALID`, `PASSWORD_RESET_EXPIRED`, `NOT_FOUND`, `CONFLICT`, `INVITATION_INVALID`, `INVITATION_EXPIRED` to the catalog in `packages/shared`
- [x] 1.5 Tests (`pnpm smoke:portal`): no token → 401; wrong password → 401; removed user → 401; logout → 401; password change and reset end other sessions
- [x] 1.7 Password reset: `POST /v1/auth/password-reset/request` (always 204) and `/confirm`; single-use 30-minute token; `password_resets` (B24, 0005)
- [x] 1.8 Per-IP rate limit per route group, no lockout; only a proxy on the host is trusted for `X-Forwarded-For` (B25)
- [ ] 1.6 Tests (edge cases): made-up token → 401; expired session → 401; `super_admin` with a `company_id` → 401; `company_id` in body ignored; disabled user with a live session → 401 before any tenant read; suspended company user → `GET /v1/me` 200

## 2. role-access

- [ ] 2.1 Permission matrix as one table in `packages/shared`; every portal and staff route declares its roles, and a route without a declaration fails to start
- [ ] 2.2 Manager filter on every query that reads `employees` or rows keyed by `employee_id`
- [ ] 2.3 Tests: each role × each area returns the matrix answer; manager reading an employee of another manager → 404; company A user requesting a company B ID → 404; tenant isolation: two companies' users in parallel never see each other's rows
- [ ] 2.4 Tests (edge cases): undeclared route fails startup; manager write with another company's ID → 403 not 404; it_admin screenshots → 403; manager reads productivity rules, write → 403; manager `manager_user_id` of another manager → 403; employee moved to another manager → 404 on the next request

## 3. team-invitations

- [x] 3.1 `GET /v1/team`, `POST /v1/team/invitations`, resend, cancel
- [x] 3.2 Invitation email through Resend with the token link; invitation lifetime constant in `packages/shared`
- [x] 3.3 `POST /v1/invitations/lookup` and `POST /v1/invitations/accept`: `users` row with a password hash, `accepted_at` and a session, one transaction
- [x] 3.4 `PATCH /v1/team/users/:id` and `DELETE /v1/team/users/:id`, with the last-admin check and session revocation
- [ ] 3.5 Tests: duplicate open invite → 409; accept twice → 410; expired → 410; unknown → 404; last company admin cannot be removed or demoted; the token never appears in a log; tenant isolation: company A admin cannot list, resend or cancel company B invitations
- [ ] 3.6 Accept: lock the invitation row (`FOR UPDATE`) for accept, resend and revoke; roll back the user when any write fails; check `users.email` again at accept; serialise role changes and removals on the company's `company_admin` rows so the last-admin check cannot race
- [ ] 3.7 Tests (edge cases): email of a user in another company → 409 revealing nothing; case-only duplicate → 409; disabled user's email → 409; concurrent invites → one 201, one email; old token after resend → 404 `INVITATION_INVALID`; expired invitation resent; concurrent accepts → one 201, one 410, one user; accept at `expires_at` → 410; email became a user meanwhile → 409, invitation open; disabled inviter still accepted; suspended company accept works; resend accepted → 409; revoke twice → 204 with first `revoked_at`; revoke accepted → 409; revoke vs accept race; DB failure → no user, invitation open; weak password → 422; last admin self-demotion → 409; two admins demote each other → one remains; manager → it_admin clears `manager_user_id`; other company user → 404; role `super_admin` → 422

## 4. staff-accounts

- [ ] 4.1 `GET /v1/staff/team`, `POST /v1/staff/invitations`, `DELETE /v1/staff/invitations/:id`, `DELETE /v1/staff/users/:id`
- [x] 4.2 TOTP MFA before any staff session: `mfa_token` at login, `POST /v1/auth/mfa/enroll` and `/verify`, 5 attempts, replay refused; `POST /v1/staff/users/:id/mfa/reset` (B23, 0005)
- [x] 4.3 Operator script that creates the first `super_admin` (no route): `pnpm seed -- --staff-email`
- [ ] 4.4 Tests: company invitation with role `super_admin` → 422; staff password without a code gives no session; no route returns a token for another user; staff team list contains no company users
- [ ] 4.5 Tests (edge cases): staff invite of a company user's email → 409; wrong code → 401 `MFA_CODE_INVALID` with `attempts_left`; sixth code → 401; code reused → 401; company roles not asked for MFA; staff self-disable → 409; last two staff disabling each other → one remains; disabled staff with a live session → 401; company user ID on the staff delete route → 404
