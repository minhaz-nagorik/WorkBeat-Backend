# Backend decisions — B1–B21

Rulings this repository made where the plan is silent. Each must agree with WorkBeat Plan v3.5 and
its D-numbers; a disagreement is a defect. Cite them as `B<n>` in specs.

| # | Decision | Why |
|---|---|---|
| B1 | This repository holds `apps/api` (NestJS + Fastify), `packages/shared` (zod contract, constants) and `db/`. The web platform (WorkBeat Admin) is its own repository and consumes `packages/shared` | Plan §6.5 lists one monorepo; the agents already live in their own repositories, and the web platform follows them |
| B2 | Each request runs in one transaction that first sets `app.scope` (`tenant`, `staff`, `system`) and, for `tenant`, `app.company_id`. Row-level security uses them | Plan §6.1 defence in depth; a missed filter returns nothing |
| B3 | Credentials are resolved before a tenant is known through `SECURITY DEFINER` lookups (`auth_device`, `auth_license`, `auth_enrollment_token`, `auth_invitation`, `company_by_host`) that return only what the guard needs | The API never needs a bypass-RLS connection on a request path |
| B4 | Seats used are counted from devices that are neither deactivated nor released, never stored; a trigger refuses the device that would exceed `seat_limit` | D43: seats survive a key reissue and are freed by release; a counter could drift |
| B5 | One global sequence feeds every `policy_version`; a device's version is the greatest of its company's, its employee's and its own | Replaces Plan §6.2 `policy_versions`; the version only grows, so a change in any scope always shows |
| B6 | Licence keys and the uninstall token are stored as SHA-256 for lookup and AES-256-GCM ciphertext (key from the environment) for display. Every other secret is hash-only | The portal must show and copy both (prototype) |
| B7 | Ingested activity records whose time is outside [server now − 8 days, server now + 1 day] are dropped and counted in the response; the batch is still accepted. A screenshot outside the window is refused (422), since its request carries one record. Tamper events are accepted at any age (D24). `ingest_batches` rows are kept 14 days | The agent keeps at most 7 days (D7); a skewed clock must not quarantine a whole batch |
| B8 | `/license/validate` has two steps: without `employee_id` it returns the company and employee list; with `employee_id` it also issues the single-use enrollment token, bound to that employee | D47 makes the employee required and the token carries it |
| B9 | This repository owns the error envelope, the `code` catalog and the payload schemas the agents consume; it answers agent open question Q1 | Plan §3 "Shared types" |
| B10 | `/cron/*` routes authenticate with a shared secret header from the scheduler and run in `system` scope | Plan §3 "Scheduled jobs" |
| B11 | `screenshot_interval_seconds` is one of 0, 600, 1800, 3600, and not more frequent than the company's tier | The agents accept only these values |
| B12 | An employee has at most one manager | Prototype "Manager teams"; the PRD's many-to-many is not used |
| B13 | Data retention is per company, 1–365 days; partitions older than 365 days are dropped | PRD "Retention and suspension"; partitions cannot be dropped per company |
| B14 | Company status adds `trial` beside `active`, `suspended` and `expired` | Prototype staff area; PRD Starter plan has a 14-day trial |
| B15 | `/cron/cleanup` commits each delete batch in its own short transaction under a per-job advisory transaction lock, and stops at a time budget. Amends B2 for that route only | A retention run can delete millions of rows; one transaction would hold a pooled connection for minutes |
| B16 | `update_package_url` is signed once per release per UTC day and valid to the end of the next day | A fresh signature per request would change the policy ETag every time, so `304` would never happen |
| B17 | `POST /v1/devices/:id/deactivate` with a device key is exempt from `402`: it frees the seat even while the company is suspended or expired | An uninstall must never leave a seat held |
| B18 | `it_admin` can list employees (`id`, `name`, `email`, `department`); it reaches no report, screenshot, pause or monitoring setting | Plan §4.5 gives Employees to Admin and Manager, but IT manages devices and needs to know whom each device is bound to; there is no reassign picker (PRD role table allows it) |
| B19 | Each company has an IANA `timezone` (default `UTC`) that bounds days and weeks in reports, calendars, timesheets, the screenshot day and daily digests | The PRD calendar and Monday-start timesheet need a company day |
| B20 | A device's employee is fixed for the life of its binding; there is no reassign route; enrollment for another employee on a live binding answers `409 DEVICE_ASSIGNED` | D48: records belong to the binding that uploaded them, so one employee's data never reaches another. A trigger refuses `UPDATE devices SET employee_id` (0003) |
| B21 | A released key is accepted on the upload routes (`POST /v1/agents/activity`, `POST /v1/agents/screenshots`, `.../confirm`) for 7 days after `released_at`; every other route answers `401 DEVICE_RELEASED` | D45: the agent uploads what it holds for up to 24 h; 7 days covers a device that was offline at release |
