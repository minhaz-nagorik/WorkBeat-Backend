# Reply to WorkBeat Admin — round 5

**From:** WorkBeat-Backend · **To:** WorkBeat Admin · **Date:** 17 November 2026
**Answers:** `WorkBeat-Admin/docs/backend-requests-5.md`

All four items are built and live on the test API (same tunnel URL). Added to `staff-api.md`,
`portal-api.md`, the code catalog and the specs `staff-companies`, `staff-accounts` and
`user-authentication`. Migration 0007.

## Built as asked

1. `POST /v1/staff/companies` → `201 { company, invitation: { email, expires_at } }`. One
   transaction (company, licence with new key, default sensitive domains, `company_admin`
   invitation for 7 days); one email after commit with the company name, licence key and
   `PORTAL_URL/invite?token=…`. `409 CONFLICT` with `fields: ["slug"]` or `["admin_email"]`;
   `422 VALIDATION_FAILED` naming each bad field.
2. `GET /v1/staff/company-admins?q=&company_id=` → array as specified, newest first.
3. `POST /v1/staff/users/:id/temporary-password` → `200 { temporary_password, expires_at }`,
   `Cache-Control: no-store`, sessions ended, password emailed, 72 hours.
4. `must_change_password` on the login `user` and on `GET /v1/me`; everything else answers
   `403 PASSWORD_CHANGE_REQUIRED` until `POST /v1/auth/password` succeeds. An expired temporary
   password answers `401 UNAUTHENTICATED`.

## Differences from your contract

| Item | Yours | Built | Why |
|---|---|---|---|
| `slug` | `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$` (3–40) | 3–32 characters, `^[a-z0-9]+(-[a-z0-9]+)*$` | The database's `companies.slug` rule: no `--`, at most 32. Use this one in the form |
| `trial_days` with `status: active` | — | ignored, `trial_ends_at` stays `null` | |
| `trial_days` missing on a trial | — | `422` with `fields: ["trial_days"]` | |
| Temporary password | ≥ 12 readable characters | 16 characters as `xxxx-xxxx-xxxx-xxxx`, no `0 O 1 l I i` | |
| `new_password` equal to the current | for the temporary password | refused for every password change | Simpler, never wanted |

A password reset by email also clears `must_change_password`.

## Email

Yes: every email (new company, temporary password, invitations, resets) goes through the
temporary SMTP until `RESEND_API_KEY` is set. They may land in spam until then.
