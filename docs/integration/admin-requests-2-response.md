# Backend reply to WorkBeat Admin's requests — round 2

**Answers:** `WorkBeat-Admin/docs/backend-requests-2.md` (16 November 2026).
**State:** live in `apps/api`, covered by `pnpm smoke:portal` (staff part with two test staff) and
`pnpm test` (TOTP against the RFC 6238 vectors). Decisions B22–B27 in
[backend-decisions.md](../decisions/backend-decisions.md).

## 1.1 Staff MFA — built (B23)

1. **Method:** TOTP (RFC 6238): any authenticator app, SHA-1, 6 digits, 30-second steps; the
   previous, current and next step are accepted, and a step already used is refused.
2. **Enrolment** happens inside the first sign-in, with the `mfa_token` (no session exists yet):
   - `POST /v1/auth/mfa/enroll { mfa_token }` → `200 { secret, otpauth_uri }`. Render
     `otpauth_uri` as a QR code; show `secret` for manual entry. Calling it again replaces the
     pending secret. A user who already has a factor → `409 CONFLICT`.
   - `POST /v1/auth/mfa/verify { mfa_token, code }` with the first code confirms the factor and
     signs in.
3. **Challenge:** `POST /v1/auth/login` for a `super_admin` with the right password →
   `200 { mfa_required: true, mfa_enrolled: bool, mfa_token, expires_at }`, no session. Then
   `POST /v1/auth/mfa/verify { mfa_token, code }` → `200 { token, expires_at, user }`.
   `mfa_enrolled: false` → go to enrolment first; verify before enrolling → `409 CONFLICT` (not
   counted as an attempt). Company users get `{ mfa_required: false, token, expires_at, user }` from
   the same login call.
4. **Recovery:** another `super_admin` calls `POST /v1/staff/users/:id/mfa/reset` →
   `200 { id, mfa_enabled: false }`. That ends the person's sessions; their next login returns
   `mfa_enrolled: false` and they enroll again. Resetting yourself → `409 CONFLICT`; a company user's
   ID → `404`; a company role → `403`. If the last staff member loses their phone, the operator
   clears the factor in the database (runbook).
5. **Wrong code:** `401 MFA_CODE_INVALID` with `attempts_left`. The `mfa_token` lasts 10 minutes and
   allows 5 wrong codes; after that, or once expired, `401 UNAUTHENTICATED` → sign in with the
   password again. `/v1/auth/*` is also limited to 20 requests a minute per IP (`429`).

Because a staff session exists only after the second factor, `MFA_REQUIRED` is never returned and
there is no `aal`.

## 1.2 Staff sign-in route — confirmed

`super_admin` signs in through the same `POST /v1/auth/login` (answer as above), and `GET /v1/me`
returns `role: "super_admin"`, `company: null`. Every company route answers a staff session `403`.
The first staff account comes from the operator script `pnpm seed -- --staff-email …`; staff
invitations arrive with the staff API.

## 1.3 Backend OpenSpec — updated

`openspec validate --all --strict`: 14 of 14 pass. The capabilities carry the 16 November behaviour;
cite them instead of the reply documents:

| Capability (change) | Now specifies |
|---|---|
| `user-authentication` (authenticate-users) | login, logout, password change, the `wbs_` session (7 days) and what ends it, password reset, sign-in rate limits, `company.timezone` on `/v1/me`; Supabase wording removed |
| `staff-accounts` (authenticate-users) | TOTP before any staff session, enrolment, attempts and replay, reset by another super admin |
| `team-invitations` (authenticate-users) | accept returns a session |
| `employee-directory` (manage-employees) | `presence` (values, order), `devices`, `manager_user_id` filter |
| `device-status` (receive-device-health) | `health` fields; `released_at`, `deactivated_at` on list rows |
| `usage-reports` (report-usage) | `group_by` and `periods` |
| `alerts-feed` (process-tamper-alerts) | `{ items, next_cursor, counts }`, `employee_id` filter |
| `block-rules` (serve-agent-policy) | `created_by_name` |
| `agent-updates` (distribute-agents) | `GET /v1/agent-versions` |

`docs/core/api/portal-api.md`, `staff-api.md` and `README.md` no longer describe Supabase tokens;
the sign-in routes are listed at the top of `portal-api.md` "Session".

## 2.1 Password reset — option (a), built (B24)

- `POST /v1/auth/password-reset/request { email }` → always `204`. For an enabled account it emails
  `<PORTAL_URL>/reset-password?token=…`; the email is sent after the answer, so timing reveals
  nothing either.
- `POST /v1/auth/password-reset/confirm { token, new_password }` → `200 { changed: true }`. The
  token is single-use and valid 30 minutes. It ends every session and open MFA challenge of the
  user; they then sign in normally (staff still need their code). Unknown token →
  `404 PASSWORD_RESET_INVALID`; used or expired → `410 PASSWORD_RESET_EXPIRED`; password outside
  10–200 characters → `400`/`422 VALIDATION_FAILED`.

The sign-in page can show "Forgot password".

## 2.2 Sign-in protection — rate limit only (B25)

20 requests a minute per IP on `/v1/auth/*` (a separate bucket from `/v1/invitations/*` and
`/v1/license/validate`), answered `429 RATE_LIMITED` with `Retry-After` in seconds. No lockout: it
would let anyone lock out a company's admins by guessing. Show "Too many attempts, try again in N
seconds" on `429`, and the generic "Wrong email or password" on `401` (the same answer for an unknown
email). The client IP comes from `X-Forwarded-For` only through a proxy on the API host, so the
limit can't be bypassed with a faked header.

## 3. Staff API field names

Unchanged from round 1; the names you assume (`upload_url`, `storage_path`, `expires_at`; resend as
the company team; `custom_domain_checked_at` ISO or `null`) are the ones we will use, and we will
confirm when the staff API lands.
