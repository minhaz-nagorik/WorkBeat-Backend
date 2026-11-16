# Backend reply to WorkBeat Admin's requests — round 3

**Answers:** `WorkBeat-Admin/docs/backend-requests-3.md` (16 November 2026).
**State:** code changes live and covered by `pnpm smoke:portal`; `openspec validate --all --strict`
passes 14 of 14; `portal-api.md`, `staff-api.md` and `README.md` contain no "not specified" any more.

## A. Fields and parameters

| # | Answer |
|---|---|
| Q26 | `key_last4` on every `GET /v1/staff/companies` row, and `q` also matches it. Specified (`staff-companies`); lands with the staff API |
| Q27 | `expired_blocking_grace_days` on the list and `/:id`. Specified; lands with the staff API |
| Q28 | **Live.** `resolved_by_name` on every `GET /v1/alerts` item (and the resolve answer); `created_by_name` on every pause (list, create, extend, cancel). `null` when there is no such user |
| Q30 | **Live.** `GET /v1/alerts?q=` (≤ 100 characters): literal, case-insensitive match on `event_type`, `hostname`, the employee's name and `detail`, combined with the other filters and applied to `counts`. Type **labels** are the web platform's: to search by label, map the matching labels to `type=` yourself |

## B. Behaviour

| # | Answer (spec) |
|---|---|
| Q29 | A `super_admin` invitation's accept answers `201 { user }` with **no session**; the person signs in and sets up TOTP (`staff-accounts`). Your assumption holds |
| Q31 | **Not refused.** No portal read or write answers `402` or is refused because the company is `suspended` or `expired`; only agent and Downloader routes get the `402` codes (`company-status`). Keep forms enabled |
| Q32 | Confirmed: every list except alerts is returned whole, sized for a company of 5,000 employees and 5,000 devices; growing past that would add a cursor through a spec change first (`api-envelope`). Page and search in the browser |
| Q33 | Yes: `409 CONFLICT` for an email with an open staff invitation or any `users` row (`staff-accounts`) |
| Q34 | Yes: `PATCH /v1/staff/companies/:id/license` with `plan: "enterprise"` moves a `starter` or `growth` licence to Enterprise with the given `seat_limit`. Only a `seat_limit` change that keeps Starter or Growth is `409` (`staff-companies`). Offer Enterprise on every company |
| Q35 | Windows `signature` is `null` or omitted (MSIs are unsigned, W35); an empty string → `422`; required for macOS (`agent-releases`) |

## C. Names

Every name is now in the docs, taken from the code:

- **Responses:**
  - invitation lookup: `company_name`;
  - billing: `scheduled_screenshot_tier`, `scheduled_at`, both `null` until Stripe exists;
  - billing portal session: `{ url }` (not built);
  - uninstall-token reveal: `{ uninstall_token }`;
  - setup: `[{ step, done }]`;
  - rollout: `{ status: { online, offline, tamper, deactivated, released }, badges: { outdated, permission_pending, browser_access_pending, paused }, healthy }`;
  - import: `{ created, skipped, skipped_emails }`, and `lines` on `422`;
  - screenshots: `{ screenshots_enabled, items }`;
  - reports: `apps`, `websites`, `hours: [{ hour, tracked_seconds, activity_percent }]`, and `periods` with `group_by`;
  - timesheet: `{ employee: { name, email }, company: { name }, week, days, totals }`;
  - daily-summary CSV: `employee_name, employee_email, date, tracked_seconds, activity_percent, productive_seconds, neutral_seconds, unproductive_seconds`;
  - `EXPORT_TOO_LARGE`: `cap` (100,000);
  - staff company list: `{ items, totals: { companies, seats_used, mrr_estimate, suspended } }`;
  - staff team: `{ users: [{ id, name, email, mfa_enabled, created_at }], invitations: [{ id, email, created_at, expires_at }] }`.
- **Requests:**
  - alerts: `cursor` = the previous `next_cursor`; `type` is comma-separated (`type=hosts_modified,offline`);
  - CSV import: the raw file as the body with `Content-Type: text/csv` (UTF-8, ≤ 2 MiB, ≤ 5,000 rows);
  - `PUT …/monitoring-settings`: all five fields required;
  - staff companies: `status` and `q`, newest first, not paged.
- **Write responses:**
  - creates → `201` with the record;
  - updates and actions → `200` with the record (each route in `portal-api.md` and `staff-api.md` names it);
  - deletes → `204`;
  - `POST /v1/company/setup/steps` → `204`.
- **`GET /v1/employees/:id` for `it_admin`:** confirmed, the same four fields as the list.
- **404 on staff routes:** specified: an ID of no row of the route's kind → `404 NOT_FOUND` (`staff-companies`).

**`packages/shared` — not now.** It does not exist yet; the schemas live in
`apps/api/src/contract.ts` and the route modules. Building a typed shared package for about 70
routes is a project of its own. Until then the docs above are the contract, and every name in them
is the one the code returns. Ask for it as its own request when the admin app is ready to consume it.

## D. Staff API

The names you assume are the ones specified: `upload_url`, `storage_path`, `expires_at` for
`POST /v1/staff/agent-releases/upload-url`; resend as the company team; `custom_domain_checked_at`
ISO or `null`. The staff API itself is specified but not built yet (only the TOTP sign-in and
`POST /v1/staff/users/:id/mfa/reset` are live).

## E. Housekeeping

Done: `team-invitations` now says the route updates the `users` row (read by every session on its
next request) and revokes the sessions on removal. The last Supabase wording is also gone from
`company-signup` (the buyer gets a set-password link), the cron and retention specs, and the
foundation tasks.

## F. Not requested

Noted; nothing built for them.
