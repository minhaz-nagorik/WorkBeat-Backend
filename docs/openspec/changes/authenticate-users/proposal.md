## Why

Company users and WorkBeat staff sign in through the API's own password sign-in (D41, B22), so the role and
company in a token are the only thing between a customer and another company's data, or a
customer and the staff area (Plan-v3.5 §8 "One sign-in for staff and company users"). Every
portal route needs the same guard: a verified token, a role allowed by the permission matrix
(Plan-v3.5 §4.5, PRD "Permission matrix"), a manager limited to their team (B12), and staff
held to MFA with no self sign-up (Plan-v3.5 §4.4, §4.6).

## What Changes

- **Sign-in and sessions**: email and password, opaque session tokens stored hashed, logout,
  password change and self-service reset (B22, B24), per-IP rate limits (B25); `GET /v1/me`.
- **Role guard** with the permission matrix, manager scoping to `employees.manager_user_id`,
  and `404` for another company's IDs.
- **Team invitations**: a company admin invites, resends, cancels, changes roles and removes
  users; anyone accepts with the emailed token.
- **Staff accounts**: invited only by another `super_admin`, TOTP MFA before any staff session (B23),
  no sign-up route, no impersonation.

## Capabilities

### New Capabilities

- `user-authentication`: token verification, `GET /v1/me`, disabled users, the `401` answer.
- `role-access`: the permission matrix, manager scoping, the `403` and `404` answers.
- `team-invitations`: company invitations, acceptance, role changes and removal.
- `staff-accounts`: staff invitations, MFA, no sign-up and no impersonation.

### Modified Capabilities

None.

## Impact

- Consumed by the web platform (WorkBeat Admin): sign-in, team page, staff team page.
- Every later portal and staff route applies `role-access`.
- New portal codes: `UNAUTHENTICATED`, `FORBIDDEN`, `MFA_CODE_INVALID`, `PASSWORD_RESET_INVALID`,
  `PASSWORD_RESET_EXPIRED`, `NOT_FOUND`, `CONFLICT`,
  `INVITATION_INVALID`, `INVITATION_EXPIRED`, added to the catalog in `packages/shared` (B9).
- Schema: `users`, `invitations` and `auth_invitation` in `0001_init.sql`; `password_hash`, `sessions`,
  `auth_session`, `auth_login` in `0004_portal_auth.sql`; MFA columns, `mfa_challenges`,
  `password_resets` in `0005_mfa_and_password_reset.sql`.
