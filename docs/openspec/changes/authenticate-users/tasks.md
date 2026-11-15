> **Read first — this task list is not the requirement.**
> Capabilities: `user-authentication · role-access · team-invitations · staff-accounts`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show authenticate-users`.
> Contract: [agent-contract.md](../../../core/api/agent-contract.md) · Schema: [data-model.md](../../../core/architecture/data-model.md).

## 1. user-authentication

- [ ] 1.1 Bearer guard verifying the Supabase JWT (signature, expiry, issuer) and reading `role` and `company_id` from `app_metadata` only (D41)
- [ ] 1.2 Cross-check against `users` (same role and company, `disabled_at` NULL); set the request scope from it (B2)
- [ ] 1.3 `GET /v1/me`
- [ ] 1.4 Add `UNAUTHENTICATED`, `FORBIDDEN`, `MFA_REQUIRED`, `NOT_FOUND`, `CONFLICT`, `INVITATION_INVALID`, `INVITATION_EXPIRED` to the catalog in `packages/shared`
- [ ] 1.5 Tests: no token, expired token, forged `user_metadata.role` → 401 or ignored; disabled user → 401; `GET /v1/me` of a user in company A never returns company B
- [ ] 1.6 Tests (edge cases): JWT from an untrusted key → 401; `alg` `none` → 401; `exp` = now → 401; `super_admin` with a `company_id` → 401; `company_id` in body ignored; demoted user's old token → 401; disabled user with a valid JWT → 401 before any tenant read; suspended company user → `GET /v1/me` 200

## 2. role-access

- [ ] 2.1 Permission matrix as one table in `packages/shared`; every portal and staff route declares its roles, and a route without a declaration fails to start
- [ ] 2.2 Manager filter on every query that reads `employees` or rows keyed by `employee_id`
- [ ] 2.3 Tests: each role × each area returns the matrix answer; manager reading an employee of another manager → 404; company A user requesting a company B ID → 404; tenant isolation: two companies' users in parallel never see each other's rows
- [ ] 2.4 Tests (edge cases): undeclared route fails startup; manager write with another company's ID → 403 not 404; it_admin screenshots → 403; manager reads productivity rules, write → 403; manager `manager_user_id` of another manager → 403; reassigned employee → 404 on the next request

## 3. team-invitations

- [ ] 3.1 `GET /v1/team`, `POST /v1/team/invitations`, resend, cancel
- [ ] 3.2 Invitation email through Resend with the token link; invitation lifetime constant in `packages/shared`
- [ ] 3.3 `POST /v1/invitations/lookup` and `POST /v1/invitations/accept`: Supabase Auth user created with `app_metadata`, `users` row, `accepted_at`, one transaction
- [ ] 3.4 `PATCH /v1/team/users/:id` and `DELETE /v1/team/users/:id`, with the last-admin check and session revocation in Supabase Auth
- [ ] 3.5 Tests: duplicate open invite → 409; accept twice → 410; expired → 410; unknown → 404; last company admin cannot be removed or demoted; the token never appears in a log; tenant isolation: company A admin cannot list, resend or cancel company B invitations
- [ ] 3.6 Accept: lock the invitation row (`FOR UPDATE`) for accept, resend and revoke; delete the Supabase Auth user when the DB write fails; check `users.email` again at accept; serialise role changes and removals on the company's `company_admin` rows so the last-admin check cannot race
- [ ] 3.7 Tests (edge cases): email of a user in another company → 409 revealing nothing; case-only duplicate → 409; disabled user's email → 409; concurrent invites → one 201, one email; old token after resend → 404 `INVITATION_INVALID`; expired invitation resent; concurrent accepts → one 201, one 410, one Auth user; accept at `expires_at` → 410; email became a user meanwhile → 409, invitation open; disabled inviter still accepted; suspended company accept works; resend accepted → 409; revoke twice → 204 with first `revoked_at`; revoke accepted → 409; revoke vs accept race; DB failure after Auth user → no Auth user, invitation open; weak password → 422; last admin self-demotion → 409; two admins demote each other → one remains; manager → it_admin clears `manager_user_id`; other company user → 404; role `super_admin` → 422

## 4. staff-accounts

- [ ] 4.1 `GET /v1/staff/team`, `POST /v1/staff/invitations`, `DELETE /v1/staff/invitations/:id`, `DELETE /v1/staff/users/:id`
- [ ] 4.2 MFA check on the JWT `aal` claim for every `super_admin` request
- [ ] 4.3 Operator script that creates the first `super_admin` (no route), documented in the runbook
- [ ] 4.4 Tests: company invitation with role `super_admin` → 422; staff token at `aal1` → 403 `MFA_REQUIRED`; no route returns a token for another user; staff team list contains no company users
- [ ] 4.5 Tests (edge cases): staff invite of a company user's email → 409; `aal1` staff invite → 403 `MFA_REQUIRED`, nothing written; `aal1` `GET /v1/me` → 200; missing `aal` → treated as `aal1`; company roles not asked for MFA; staff self-disable → 409; last two staff disabling each other → one remains; disabled staff with `aal2` token → 401; company user ID on the staff delete route → 404
