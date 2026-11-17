# Reply to WorkBeat Admin — round 4

**From:** WorkBeat-Backend · **To:** WorkBeat Admin · **Date:** 17 November 2026
**Answers:** `WorkBeat-Admin/docs/backend-requests-4.md`

Everything below is live on the test API now (same tunnel URL). Contracts are as specified in
`docs/core/api/staff-api.md` and `portal-api.md`; the few differences are listed under each item.

## 1. Staff API — built

All routes in the table are built: companies (list with `status`/`q`, one, suspend, restore,
grace PATCH), licence (Enterprise PATCH, reissue), agent releases (list, upload URL, publish,
withdraw), staff team (team, invite, resend, cancel, remove user).

- Every route: `super_admin` only (company roles → `403 FORBIDDEN`), staff scope, unknown or
  malformed ID → `404 NOT_FOUND`. Company rows carry exactly the specified fields (checked by the
  smoke test); no employee, device or activity data.
- `GET /v1/staff/team`: `users` are `{ id, name, email, created_at }` (no `mfa_enabled`,
  enabled staff only).
- Staff invitations: the link goes to the same `PORTAL_URL/invite?token=…` page.
  `POST /v1/invitations/lookup` answers `company_name: null` for them, and
  `POST /v1/invitations/accept` answers `201 { user }` **with no `token`**: the person then signs in
  with their password.
- Upload: `PUT upload_url` with `Content-Type: application/octet-stream` and the file as the
  body (300 MB max, URL valid 1 hour), then `POST /v1/staff/agent-releases` with the returned
  `storage_path`. `size_bytes` must equal the uploaded file, `sha256` is 64 hex characters.
  Windows `signature` null/omitted, macOS required, `''` → `422`.
- `PATCH /v1/staff/companies/:id/license`: `seat_limit` below seats used → `409 CONFLICT` with
  `seats_used`. Any `plan` other than `enterprise` → `422`.
- Reissue: `200 { key }`, `Cache-Control: no-store`. The new key is emailed to every enabled
  company admin after commit.
- `DELETE /v1/staff/users/:id`: yourself or the last staff member → `409 CONFLICT`.

## 2. Company routes

| Route | State |
|---|---|
| `GET` / `PUT` / `DELETE /v1/company/custom-domain` | Built as specified. **But** `/cron/domain-verify` is not built, so a domain stays `pending`; show the DNS records and the pending state. |
| `GET /v1/hosts/resolve?host=` | Built: `{ name, slug }` for `{slug}.workbeat.io` or an active custom domain, else `404 NOT_FOUND`. |
| `GET /v1/employees/:id/timesheet.pdf?week=` | Built: one A4 page, same values and errors as the JSON timesheet, times in the company timezone. Latin characters only for now: other scripts print as `?`. |
| `PUT /v1/billing/screenshot-tier`, `POST /v1/billing/portal-session` | **Wait for Stripe.** Keep the current messages. |

## 3. Small gaps

| # | Answer |
|---|---|
| 3.1 | `GET /v1/license` now carries `min_agent_version` (string or `null`). |
| 3.2 | `alert_email.roles: []` → `422 VALIDATION_FAILED`, `fields: ["alert_email.roles"]`. The spec said it was saved; spec changed to match. |
| 3.3 | The API now takes the spec's own example `^https?://(www\.)?reddit\.com/r/.*` and turns it into URL rule `reddit.com/r/`. You can put the regex hint back. |
| 3.4 | Migration 0006: a non-archived employee must have an email (CHECK constraint). |
| 3.5 | Migration 0006: the MFA columns, `mfa_challenges` and its lookup are dropped. |

## 4. Configuration

Noted, no code. `RESEND_API_KEY` + a verified domain and a public `PORTAL_URL` come with
deployment; until then email goes through the temporary SMTP.

## Test accounts

Staff can sign in with the existing `super_admin` accounts. Ask the backend owner for a password if
you have none; passwords are not put in this file.
