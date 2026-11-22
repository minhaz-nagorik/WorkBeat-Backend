# Portal API

Company-facing routes used by WorkBeat Admin, for `company_admin`, `manager` and `it_admin`.
Conventions, auth and the code catalog are in [README.md](README.md).

**Applies to every route below unless it says otherwise; not repeated per route:**

- `Authorization: Bearer <session token>` from `POST /v1/auth/login` (B22); missing, bad, expired or disabled → `401 UNAUTHENTICATED`.
- `super_admin` → `403 FORBIDDEN` (except `GET /v1/me` and the no-credential routes).
- `400`/`422 VALIDATION_FAILED`, `413 PAYLOAD_TOO_LARGE`, `429 RATE_LIMITED`, `500 INTERNAL`.
- Tenant from the token; an ID of another company → `404 NOT_FOUND`
  ([`role-access`][role-access]).
- "Own team" means employees whose `manager_user_id` is the calling manager; any other employee →
  `404` (or the code shown) and is left out of lists ([`manager-teams`][manager-teams]).

Contents: [Session](#session) · [Team & invitations](#team--invitations) ·
[Company & billing](#company--billing) · [Settings & domain](#settings--domain) ·
[Licence & deployment](#licence--deployment) · [Employees](#employees) ·
[Monitoring settings & pauses](#monitoring-settings--pauses) · [Devices](#devices) ·
[Policy](#policy) · [Alerts](#alerts) · [Screenshots](#screenshots) · [Reports](#reports) ·
[Exports](#exports) · [Dashboard](#dashboard) · [Unspecified](#unspecified)

---

## Session

Signed-in requests are limited to 600 a minute per session. Sign-in routes need no credential and are limited to 20 a minute per IP each (`429 RATE_LIMITED`,
no lockout, B25). Spec: [`user-authentication`][user-authentication], [`staff-accounts`][staff-accounts].

| Route | Body | Answer |
|---|---|---|
| `POST /v1/auth/login` | `email`, `password` | `{ token, expires_at, user }` for every user, `super_admin` included; wrong → `401 UNAUTHENTICATED` |
| `POST /v1/auth/logout` | — (Bearer) | `204` |
| `POST /v1/auth/password` | `current_password`, `new_password` (Bearer) | `{ changed: true }`; other sessions end; wrong current → `422`; new equal to current → `422` naming `new_password`; clears `must_change_password` |
| `POST /v1/auth/password-reset/request` | `email` | always `204`; emails a 30-minute single-use link to `<PORTAL_URL>/reset-password?token=…` |
| `POST /v1/auth/password-reset/confirm` | `token`, `new_password` | `{ changed: true }`, every session ends; `404 PASSWORD_RESET_INVALID`, `410 PASSWORD_RESET_EXPIRED` |

### `GET /v1/me`
Roles: company_admin, manager, it_admin, super_admin · Spec: [`user-authentication`][user-authentication]
Who the caller is.
Request: none.
Response `200`:

| field | type | notes |
|---|---|---|
| id | uuid | |
| email | string | |
| name | string | |
| role | enum(company_admin\|manager\|it_admin\|super_admin) | from `app_metadata` |
| company | object \| null | `{ id: uuid, name: string, slug: string, status: enum(trial\|active\|suspended\|expired) }`; `null` for `super_admin` |
| must_change_password | bool | true after staff set a temporary password; also on the login `user` |

Errors: `401 UNAUTHENTICATED` (no token, expired, disabled user, role/company mismatch, company role without `company_id`).
Notes: open to a `super_admin` too, with `company: null` ([staff-api.md](staff-api.md#get-v1me)).

**Temporary password.** While `must_change_password` is true, every route except `GET /v1/me`,
`POST /v1/auth/password` and `POST /v1/auth/logout` answers `403 PASSWORD_CHANGE_REQUIRED`. The
temporary password stops working 72 hours after it was set (`401 UNAUTHENTICATED`, like a wrong one).

### `POST /v1/invitations/lookup`
Roles: none (no credential) · Spec: [`team-invitations`][team-invitations]
Show what an invitation link is for before accepting.
Request:

| field | type | required | notes |
|---|---|---|---|
| token | string | yes | from the emailed link |

Response `200`:

| field | type | notes |
|---|---|---|
| email | string | |
| role | enum(company_admin\|manager\|it_admin\|super_admin) | |
| company_name | string | the company `name` |

Errors:

| status | code | when |
|---|---|---|
| 404 | `INVITATION_INVALID` | token matches no invitation |
| 410 | `INVITATION_EXPIRED` | accepted, revoked or past `expires_at` |

Notes: token resolved only through `auth_invitation` (SHA-256).

### `POST /v1/invitations/accept`
Roles: none (no credential) · Spec: [`team-invitations`][team-invitations], [`staff-accounts`][staff-accounts]
Create the invited user's account.
Request:

| field | type | required | notes |
|---|---|---|---|
| token | string | yes | |
| name | string | yes | |
| password | string | yes | 10–200 characters, stored as a scrypt hash |

Response `201`: company invitation `{ token, expires_at, user }` (a session, `user` as `GET /v1/me`); staff invitation `{ user }` only, no session (the person then signs in).
Errors: as `POST /v1/invitations/lookup`; no user is created on either.
Notes: in one transaction: `users` row, `invitations.accepted_at` and a session, returned as `{ token, expires_at, user }`. A staff invitation creates a user with no `company_id`.

---

## Team & invitations

### `GET /v1/team`
Roles: company_admin · Spec: [`team-invitations`][team-invitations]
The company's users and open invitations.
Request: none.
Response `200`:

| field | type | notes |
|---|---|---|
| users | array<object> | `{ id, name, email, role, created_at }`; disabled users left out. Key name (derived) |
| invitations | array<object> | open only: `{ id, email, role, created_at, expires_at }`. Key name (derived) |

Errors: `403 FORBIDDEN` (manager, it_admin, super_admin).

### `POST /v1/team/invitations`
Roles: company_admin · Spec: [`team-invitations`][team-invitations]
Invite a colleague with a role.
Request:

| field | type | required | notes |
|---|---|---|---|
| email | string | yes | |
| role | enum(company_admin\|manager\|it_admin) | yes | `super_admin` → 422 |

Response `201`: `id` uuid, `email` string, `role` enum, `expires_at` ISO-8601 datetime. Never the token.
Errors:

| status | code | when |
|---|---|---|
| 403 | `FORBIDDEN` | not company_admin |
| 409 | `CONFLICT` | open invitation for the email in the company, or the email belongs to any `users` row |
| 422 | `VALIDATION_FAILED` | role `super_admin` or other invalid value |

Notes: writes `invitations` (caller's company, `invited_by` = caller, `token_hash` only, `expires_at` from `packages/shared`); emails the link through Resend.

### `POST /v1/team/invitations/:id/resend`
Roles: company_admin · Spec: [`team-invitations`][team-invitations]
Send a fresh link; the old one stops working.
Request: none.
Response `200`: `{ id, email, role, expires_at }`. Not open (accepted or revoked) → `409 CONFLICT`.
Errors: `403 FORBIDDEN`; `404 NOT_FOUND`.
Notes: replaces `token_hash`, renews `expires_at`, sends a new email.

### `DELETE /v1/team/invitations/:id`
Roles: company_admin · Spec: [`team-invitations`][team-invitations]
Cancel an invitation.
Request: none.
Response `204`.
Errors: `403 FORBIDDEN`; `404 NOT_FOUND`.
Notes: sets `revoked_at`; its token then answers `410 INVITATION_EXPIRED`.

### `PATCH /v1/team/users/:id`
Roles: company_admin · Spec: [`team-invitations`][team-invitations]
Change a user's role.
Request:

| field | type | required | notes |
|---|---|---|---|
| role | enum(company_admin\|manager\|it_admin) | yes | `super_admin` is refused ([`staff-accounts`][staff-accounts]) |

Response `200`: `{ id, name, email, role, created_at }`. Takes effect on the user's next request.
Errors:

| status | code | when |
|---|---|---|
| 403 | `FORBIDDEN` | not company_admin |
| 404 | `NOT_FOUND` | unknown or other company's user |
| 409 | `CONFLICT` | would leave no enabled `company_admin` |

Notes: updates `app_metadata` with the `users` row. A user who stops being a manager has their employees' `manager_user_id` set to NULL.

### `DELETE /v1/team/users/:id`
Roles: company_admin · Spec: [`team-invitations`][team-invitations]
Remove a user.
Request: none.
Response `204`.
Errors: `403 FORBIDDEN`; `404 NOT_FOUND`; `409 CONFLICT` (would leave no enabled `company_admin`, including the last admin removing themselves).
Notes: sets `disabled_at` and ends the user's sessions; their next call gets `401`. A removed manager's employees get `manager_user_id` NULL.

---

## Company & billing

### `GET /v1/company/status`
Roles: company_admin, manager, it_admin · Spec: [`company-status`][company-status]
The company's billing status.
Request: none.
Response `200`:

| field | type | notes |
|---|---|---|
| status | enum(trial\|active\|suspended\|expired) | |
| suspended_reason | enum(payment_failed\|staff) \| null | set exactly when `suspended` |
| trial_ends_at | ISO-8601 datetime \| null | |
| expired_at | ISO-8601 datetime \| null | |
| blocking_ends_at | ISO-8601 datetime \| null | `expired_at` + `expired_blocking_grace_days`, computed on read |

Errors: none route-specific.
Notes: works while suspended or expired. No company route changes `status`; a sent `status` is ignored.

### `GET /v1/billing`
Roles: none (every company role gets `403 FORBIDDEN`; staff-managed, B29) · Spec: [`subscription-sync`][subscription-sync]
Plan, seats and screenshot tier.
Request: none.
Response `200`:

| field | type | notes |
|---|---|---|
| plan | enum(starter\|growth\|enterprise) | |
| seat_limit | int \| null | null = unlimited |
| seats_used | int | counted on read (B4) |
| screenshot_tier | enum(off\|light\|standard\|intensive) | in force now |
| scheduled_screenshot_tier, scheduled_at | enum \| null, ISO-8601 \| null | always `null` until Stripe is built |
| trial_ends_at | ISO-8601 datetime \| null | |
| current_period_end | ISO-8601 datetime \| null | |

Errors: `403 FORBIDDEN`.
Notes: works while suspended or expired.

### `PUT /v1/billing/screenshot-tier`
Roles: none (every company role gets `403 FORBIDDEN`; staff-managed, B29) · Spec: [`subscription-sync`][subscription-sync]
Schedule a screenshot tier change for the period end.
Request:

| field | type | required | notes |
|---|---|---|---|
| screenshot_tier | enum(off\|light\|standard\|intensive) | yes | (derived) name from `licenses.screenshot_tier` |

Response `200`: the `GET /v1/billing` object with `scheduled_screenshot_tier` and `scheduled_at` = `current_period_end`. **Not built yet** (Stripe).
Errors: `403 FORBIDDEN`.
Notes: schedules the change in Stripe; `licenses.screenshot_tier` is unchanged until the Stripe subscription event at that date ([webhooks-and-cron.md](webhooks-and-cron.md)).

### `POST /v1/billing/portal-session`
Roles: none (every company role gets `403 FORBIDDEN`; staff-managed, B29) · Spec: [`subscription-sync`][subscription-sync]
Open Stripe's billing portal.
Request: none.
Response `200`: `{ url }`, a Stripe billing portal URL. **Not built yet** (Stripe).
Errors: `403 FORBIDDEN`.

---

## Approvals

Since 17 Nov 2026 (product owner) an `it_admin` may call the employee, import, monitoring-settings,
pause, device release/deactivate, alert resolve, block-rule, sensitive-domain and productivity-rule
**write** routes, but nothing is applied: the request is validated as for a `company_admin` (so
`400`/`404`/`409`/`422` come back at once), then stored and answered **`202 { change }`**. A
`company_admin`'s writes still apply at once. Spec: [`change-approvals`][change-approvals].

Change: `{ id, status: pending|approved|rejected|cancelled|failed, resource: employee|employee_import|monitoring_settings|pause|device|alert|block_rule|sensitive_domain|productivity_rule, action: create|update|delete|release|deactivate|resolve|cancel|import, target_id, summary, requested_by: { id, name }, requested_at, decided_by: { id, name } | null, decided_at, reason, error: { code, message } | null }`.

| Route | Roles | Answer |
|---|---|---|
| `GET /v1/changes?status=&resource=` | company_admin (all), it_admin (own) | array, newest first, ≤ 500; manager `403` |
| `POST /v1/changes/:id/approve` | company_admin | `200 { change }`: the stored request is replayed as the approver; `approved`, or `failed` with `error`. Not pending → `409` |
| `POST /v1/changes/:id/reject` | company_admin | body `{ reason? }` (≤ 500) → `200 { change }`. Not pending → `409` |
| `DELETE /v1/changes/:id` | the it_admin who asked | `204`; someone else's → `404`; not pending → `409` |

Emails: every enabled company admin when a change waits (at most one per 15 minutes per company);
the requester when their change is approved, rejected or failed.

---

## Settings & domain

### `GET /v1/company/settings`
Roles: company_admin · Spec: [`company-settings`][company-settings]
Company-wide settings.
Request: none.
Response `200`:

| field | type | notes |
|---|---|---|
| name | string | |
| slug | string | read-only |
| data_retention_days | int | 30, 60 or 90 |
| idle_threshold_seconds | int | 60–3600 |
| alert_email | object | `{ roles: array<enum(company_admin\|manager\|it_admin)>, types: array<enum(process_restart\|hosts_modified\|config_changed\|clock_tampered\|permission_revoked\|offline\|duplicate_device_id)>, delivery: enum(instant\|hourly\|daily) }` |
| timezone | string | IANA name, default `UTC` |

Errors: `403 FORBIDDEN` (manager, it_admin).

### `PATCH /v1/company/settings`
Roles: company_admin · Spec: [`company-settings`][company-settings]
Edit company settings.
Request (all optional):

| field | type | required | notes |
|---|---|---|---|
| idle_threshold_seconds | int | no | 60–3600 |
| alert_email | object | no | shape as in GET |
| timezone | string | no | known IANA name |

Response `200`: the settings as in GET.
Errors: `403 FORBIDDEN` (other roles; or `name` / `data_retention_days` in the body, named in `fields`, nothing changed: staff set them, B29); `422 VALIDATION_FAILED` (out of range, unknown zone, bad `alert_email`).
Notes: `slug` is not writable. An `idle_threshold_seconds` change raises `companies.policy_version`.

### `GET /v1/company/setup`
Roles: company_admin (it_admin `403` since round 6) · Spec: [`company-settings`][company-settings]
The onboarding checklist.
Request: none.
Response `200`: the steps `download_downloader`, `copy_license_key`, `install_first_device`, `first_device_seen`, each with `done` bool. Shape: `[{ step, done }]` in that order.
Errors: `403 FORBIDDEN` (manager).
Notes: the first two come from `setup_completed_steps`; `install_first_device` is true once the company has a device row, `first_device_seen` once one has `last_heartbeat_at`.

### `POST /v1/company/setup/steps`
Roles: company_admin (it_admin `403` since round 6) · Spec: [`company-settings`][company-settings]
Mark a manual checklist step done.
Request:

| field | type | required | notes |
|---|---|---|---|
| step | enum(download_downloader\|copy_license_key) | yes | (derived) only these two are stored |

Response `204`. Repeating a done step is a no-op.
Errors: `403 FORBIDDEN`.
Notes: adds `step` to `companies.setup_completed_steps`.

### `GET /v1/company/custom-domain`
Roles: company_admin · Spec: [`custom-domains`][custom-domains]
The custom domain and the DNS records to create.
Request: none.
Response `200` (`data` is `null` when no domain is set):

| field | type | notes |
|---|---|---|
| domain | string | lower case |
| status | enum(pending\|active\|failed) | |
| cname_target | string | `proxy.workbeat.io` |
| txt_name | string | `_workbeat.{domain}` |
| txt_value | string | `verify-{token}` |
| checked_at | ISO-8601 datetime \| null | |
| verified_at | ISO-8601 datetime \| null | |

Errors: `403 FORBIDDEN`.

### `PUT /v1/company/custom-domain`
Roles: company_admin (B33) · Spec: [`custom-domains`][custom-domains]
Set or replace the custom domain. It resolves only after staff approve it.
Request:

| field | type | required | notes |
|---|---|---|---|
| domain | string | yes | stored lower case |

Response `200`: the `GET /v1/company/custom-domain` object.
Errors:

| status | code | when |
|---|---|---|
| 403 | `FORBIDDEN` | not company_admin |
| 409 | `CONFLICT` | another company holds the domain, in any status |
| 422 | `VALIDATION_FAILED` | under `workbeat.io` or not a valid host name |

Notes: a new domain sets `custom_domain_status` `pending`, a new `custom_domain_token`, clears `custom_domain_checked_at` and `custom_domain_verified_at`; the current domain again changes nothing. Staff make it `active` with `PATCH /v1/staff/companies/:id/custom-domain`; there is no DNS job (B33).

### `DELETE /v1/company/custom-domain`
Roles: company_admin (B33) · Spec: [`custom-domains`][custom-domains]
Remove the custom domain.
Request: none.
Response `204`.
Errors: `403 FORBIDDEN`.
Notes: clears every `custom_domain*` column.

### `GET /v1/hosts/resolve`
Roles: none (no credential) · Spec: [`custom-domains`][custom-domains]
Map the sign-in page's host name to its company.
Query:

| field | type | required | notes |
|---|---|---|---|
| host | string | yes | `{slug}.workbeat.io` or a custom domain |

Response `200`: `name` string, `slug` string.
Errors: `404 NOT_FOUND` (unknown host, or a `pending`/`failed` domain).
Notes: resolved only through `company_by_host`. Never selects the company of an authenticated request.

---

## Licence & deployment

### `GET /v1/license`
Roles: company_admin (it_admin `403` since round 6) · Spec: [`license-key`][license-key]
The masked licence key and seats.
Request: none.
Response `200`:

| field | type | notes |
|---|---|---|
| key_masked | string | `WB-••••-••••-••••-` + `key_last4` |
| plan | enum(starter\|growth\|enterprise) | |
| seat_limit | int \| null | null = unlimited |
| seats_used | int | devices neither deactivated nor released |
| key_reset_at | ISO-8601 datetime \| null | last staff reissue |
| min_agent_version | string \| null | `x.y.z` set by `PUT /v1/deployment/min-agent-version` (admin round 4) |

Errors: `403 FORBIDDEN` (manager).

### `POST /v1/license/reveal`
Roles: company_admin (it_admin `403` since round 6) · Spec: [`license-key`][license-key]
Show the full licence key.
Request: none.
Response: `key` string (`WB-XXXX-XXXX-XXXX-XXXX`), with `Cache-Control: no-store`. Status `200`: `{ key }`.
Errors: `403 FORBIDDEN` (manager).
Notes: decrypts `key_ciphertext`; never logged. No company route changes the key.

### `POST /v1/license/uninstall-token/reveal`
Roles: company_admin (it_admin `403` since round 6) · Spec: [`license-key`][license-key]
Show the uninstall token IT needs to remove an agent.
Request: none.
Response `200`: `{ uninstall_token }` (`wbu_…`), with `Cache-Control: no-store`.
Errors: `403 FORBIDDEN` (manager).
Notes: decrypts `companies.uninstall_token_ciphertext`; its hash is `uninstall_token_hash` in every policy. Never logged.

### `GET /v1/downloads`
Roles: company_admin, it_admin · Spec: [`installer-downloads`][installer-downloads]
Signed links to the Downloader and the current agent packages.
Request: none.
Response `200`: array<object>, one per newest non-withdrawn `downloader` release per platform and `agent` release per platform and arch:

| field | type | notes |
|---|---|---|
| product | enum(agent\|downloader) | |
| platform | enum(macos\|windows) | |
| arch | enum(universal\|x64\|arm64) | macOS `universal`; Windows `x64`, `arm64` |
| version | string | `x.y.z` |
| size_bytes | int | |
| sha256 | string | |
| url | string | signed, private `agents` bucket, lifetime from `packages/shared` |
| expires_at | ISO-8601 datetime | |

Errors: `403 FORBIDDEN` (manager, super_admin).
Notes: a platform/arch with no live release is left out. URLs never logged.

### `PUT /v1/deployment/min-agent-version`
Roles: company_admin (it_admin `403` since round 6) · Spec: [`agent-updates`][agent-updates]
Set the company's minimum agent version.
Request:

| field | type | required | notes |
|---|---|---|---|
| min_agent_version | string \| null | yes | `x.y.z`; null clears |

Response `200`: `{ min_agent_version }`.
Errors: `403 FORBIDDEN` (manager); `422 VALIDATION_FAILED` (malformed version).
Notes: sets `companies.min_agent_version` and raises `companies.policy_version`. Effective minimum = greater of this and the global minimum ([`agent-releases`][agent-releases]); devices below it get the `outdated` badge.

---

## Employees

### `GET /v1/employees`
Roles: company_admin and it_admin (all fields, round 6), manager (own team) · Spec: [`employee-directory`][employee-directory], B18
The employee directory.
Query:

| field | type | required | notes |
|---|---|---|---|
| archived | bool | no | `true` includes archived employees |

Response `200`: array<object>:

| field | type | notes |
|---|---|---|
| id | uuid | |
| name | string | |
| email | string \| null | |
| department | string \| null | |
| manager_user_id | uuid \| null | |
| archived_at | ISO-8601 datetime \| null | |

Errors: none route-specific.
Notes: B18's narrower `it_admin` field list ended with round 6 (17 Nov 2026).

### `POST /v1/employees`
Roles: company_admin · Spec: [`employee-directory`][employee-directory], [`manager-teams`][manager-teams], [`monitoring-settings`][monitoring-settings]
Add an employee.
Request:

| field | type | required | notes |
|---|---|---|---|
| name | string | yes | non-empty |
| email | string | yes | valid address; `PATCH` may leave it out but not clear it |
| department | string | no | |
| manager_user_id | uuid \| null | no | an enabled `manager` of the company |

Response `201`: `id` uuid; other employee fields (derived) as in GET.
Errors:

| status | code | when |
|---|---|---|
| 403 | `FORBIDDEN` | not company_admin |
| 409 | `CONFLICT` | email held by a non-archived employee |
| 422 | `VALIDATION_FAILED` | `manager_user_id` not an enabled manager of the company |

Notes: creates the `employee_monitoring_settings` row: every switch true, `screenshot_interval_seconds` = tier interval (0 when `off`).

### `GET /v1/employees/:id`
Roles: company_admin, it_admin, manager (own team) · Spec: [`employee-directory`][employee-directory]
One employee.
Request: none.
Response `200`: one object as in `GET /v1/employees`.
Errors: `404 NOT_FOUND`.

### `PATCH /v1/employees/:id`
Roles: company_admin · Spec: [`employee-directory`][employee-directory], [`manager-teams`][manager-teams]
Edit an employee.
Request: `name`, `email`, `department`, `manager_user_id` as in POST, all optional.
Response `200`: the employee as in GET (company_admin fields, without `presence`). Archived → `409 CONFLICT`.
Errors: `403 FORBIDDEN`; `404 NOT_FOUND`; `409 CONFLICT` (email); `422 VALIDATION_FAILED` (manager).

### `DELETE /v1/employees/:id`
Roles: company_admin · Spec: [`employee-directory`][employee-directory]
Remove (archive) an employee.
Request: none.
Response `204`; already archived → `204`.
Errors:

| status | code | when |
|---|---|---|
| 403 | `FORBIDDEN` | not company_admin |
| 404 | `NOT_FOUND` | unknown or other company |
| 409 | `EMPLOYEE_HAS_DEVICES` | a binding (device row) of the employee has `released_at` NULL, deactivated or not (0003) |

Notes: sets `archived_at`; rows and history kept. Archived employees leave `/license/validate` and cannot be picked in WorkBeat Setup; their email is free again.

### `POST /v1/employees/:id/restore`
Roles: company_admin · Spec: [`employee-directory`][employee-directory], D46
Bring back an archived employee: same `id`, history, settings, pauses and manager.
Request (optional body):

| field | type | required | notes |
|---|---|---|---|
| email | string | no | replaces the stored email, e.g. when the old one was given to someone else |

Response `200`: the employee as in GET; not archived → `200`, nothing changes.
Errors:

| status | code | when |
|---|---|---|
| 403 | `FORBIDDEN` | not company_admin |
| 404 | `NOT_FOUND` | unknown or other company |
| 409 | `CONFLICT` | a non-archived employee holds the email |
| 422 | `VALIDATION_FAILED` | `email` malformed, or the employee has no email and none is sent |

Notes: takes no seat and creates no binding; the employee's computer enrolls again through WorkBeat Setup, which makes a new binding. Their past activity counts again in totals without `employee_id`. To offer "restore instead" when adding someone, look for the email in `GET /v1/employees?archived=true`.

### `POST /v1/employees/import`
Roles: company_admin · Spec: [`employee-directory`][employee-directory]
Import employees from CSV.
Request: a CSV with columns `name, email, department, manager email`, header row optional. Transport: the raw file as the body with `Content-Type: text/csv`, UTF-8, at most 2 MiB and 5,000 rows.
Response `201`:

| field | type | notes |
|---|---|---|
| created | int | |
| skipped | int | rows whose email matches a non-archived employee |
| skipped_emails | array<string> | on `422` the body carries `lines`: array<int> of the invalid 1-based data rows |

Errors:

| status | code | when |
|---|---|---|
| 403 | `FORBIDDEN` | not company_admin |
| 413 | `PAYLOAD_TOO_LARGE` | file over the import limit |
| 422 | `VALIDATION_FAILED` | any row with no `name`, a missing or malformed email, `manager email` not a manager of the company, an email twice in the file, or an email held only by an archived employee; names each line number |

Notes: all or nothing — any invalid row creates no employee. A `422` caused by archived employees also carries `archived`: array<{ `line` int, `employee_id` uuid, `name` string }>, so the console can offer `POST /v1/employees/:id/restore`.

### `GET /v1/employees/:id/notice-acknowledgements`
Roles: company_admin · Spec: [`notice-acknowledgement`][notice-acknowledgement]
The employee's collection-notice acknowledgements (legal evidence).
Request: none.
Response `200`: array<object>, newest first:

| field | type | notes |
|---|---|---|
| device_id | uuid | |
| hostname | string | the device's |
| notice_version | int | |
| acknowledged_at | ISO-8601 datetime | agent's time |
| received_at | ISO-8601 datetime | server time |

Errors: `403 FORBIDDEN` (manager, it_admin); `404 NOT_FOUND`.
Notes: append-only; each row belongs to the binding (device row) that sent it.

---

## Monitoring settings & pauses

### `GET /v1/employees/:id/monitoring-settings`
Roles: company_admin, manager (own team) · Spec: [`monitoring-settings`][monitoring-settings]
The employee's monitoring switches.
Request: none.
Response `200`: `activity` bool, `app_usage` bool, `window_titles` bool, `website_visits` bool, `screenshot_interval_seconds` enum(0\|600\|1800\|3600), `screenshot_tier` enum(off\|light\|standard\|intensive) (the company's plan; intervals faster than it are refused, B29).
Errors: `403 FORBIDDEN` (it_admin); `404 NOT_FOUND`.

### `PUT /v1/employees/:id/monitoring-settings`
Roles: company_admin · Spec: [`monitoring-settings`][monitoring-settings]
Change the employee's monitoring switches.
Request: `activity`, `app_usage`, `window_titles`, `website_visits` (bool) and `screenshot_interval_seconds` (int). All five are required.
Response `200`: the five fields as in GET.
Errors:

| status | code | when |
|---|---|---|
| 403 | `FORBIDDEN` | manager, it_admin |
| 404 | `NOT_FOUND` | |
| 422 | `VALIDATION_FAILED` | interval not 0/600/1800/3600; non-zero and shorter than the tier interval; non-zero while tier `off` |

Notes: sets `updated_by`, raises the employee's `policy_version`. Never changes `notice_version`.

### `GET /v1/employees/:id/pauses`
Roles: company_admin, manager (own team, read only) · Spec: [`monitoring-pauses`][monitoring-pauses]
The employee's monitoring pauses.
Request: none.
Response `200`: array<object>:

| field | type | notes |
|---|---|---|
| id | uuid | the agents' `pause_id` |
| starts_at | ISO-8601 datetime | |
| ends_at | ISO-8601 datetime | |
| reason | enum(annual_leave\|sick_leave\|personal\|offsite_training\|other) | |
| note | string \| null | |
| created_by | uuid | |
| created_by_name | string \| null | the scheduler's name |
| cancelled_at | ISO-8601 datetime \| null | |
| status | enum(scheduled\|active\|ended\|cancelled) | derived on read |

Errors: `403 FORBIDDEN` (it_admin); `404 NOT_FOUND`.

### `POST /v1/employees/:id/pauses`
Roles: company_admin · Spec: [`monitoring-pauses`][monitoring-pauses]
Schedule a pause.
Request:

| field | type | required | notes |
|---|---|---|---|
| starts_at | ISO-8601 datetime | no | omitted = server now; not before now |
| ends_at | ISO-8601 datetime | yes | after `starts_at` |
| reason | enum(annual_leave\|sick_leave\|personal\|offsite_training\|other) | yes | (derived) NOT NULL |
| note | string | no | |

Response `201`: `id` uuid; other pause fields (derived) as in GET.
Errors:

| status | code | when |
|---|---|---|
| 403 | `FORBIDDEN` | manager, it_admin |
| 404 | `NOT_FOUND` | |
| 409 | `CONFLICT` | overlaps another non-cancelled pause of the employee |
| 422 | `VALIDATION_FAILED` | `starts_at` before now, `ends_at` not after `starts_at` |

Notes: sets `created_by`; raises the employee's `policy_version` in the same transaction.

### `PATCH /v1/employees/:id/pauses/:pause_id`
Roles: company_admin · Spec: [`monitoring-pauses`][monitoring-pauses]
Extend or shorten a pause.
Request: `ends_at` ISO-8601 datetime, required; after `starts_at` and after now.
Response `200`: the pause as in GET; it keeps its `id`.
Errors: `403 FORBIDDEN`; `404 NOT_FOUND`; `409 CONFLICT` (pause cancelled or ended, or new end overlaps another pause); `422 VALIDATION_FAILED`.
Notes: raises the employee's `policy_version`.

### `POST /v1/employees/:id/pauses/:pause_id/cancel`
Roles: company_admin · Spec: [`monitoring-pauses`][monitoring-pauses]
End a pause early or call off a scheduled one.
Request: none.
Response `200`: the pause as in GET, `status` `cancelled`.
Errors: `403 FORBIDDEN`; `404 NOT_FOUND`; `409 CONFLICT` (already cancelled or ended).
Notes: sets `cancelled_at`, `cancelled_by`; row kept (no route deletes a pause). Raises the employee's `policy_version`.

---

## Devices

### `GET /v1/devices`
Roles: company_admin, it_admin · Spec: [`device-status`][device-status]
The company's devices with derived status.
Query (all optional): `status`, `badge`, `os` enum(macos\|windows), `employee_id` uuid.
Response `200`: array<object>:

| field | type | notes |
|---|---|---|
| id | uuid | |
| hostname | string | |
| os | enum(macos\|windows) | |
| os_version | string | |
| arch | enum(x64\|arm64) | |
| agent_version | string | |
| employee | object | `{ id, name }`; key name (derived) |
| status | enum(released\|deactivated\|offline\|online) | first that applies, in this order; never stored |
| badges | array<enum(outdated\|permission_pending\|browser_access_pending\|paused\|open_alert)> | Windows is never `permission_pending`; `open_alert` while an unresolved tamper event other than `offline` exists (B31) |
| last_heartbeat_at | ISO-8601 datetime \| null | |

Errors: `403 FORBIDDEN` (manager).

### `GET /v1/devices/:id`
Roles: company_admin, it_admin · Spec: [`device-status`][device-status]
One device with its health detail.
Request: none.
Response `200`: list fields plus `helper_status` object, `browser_access` object, `permissions` object, `health` object (latest heartbeat counters).
Errors: `403 FORBIDDEN` (manager); `404 NOT_FOUND`.

### `GET /v1/rollout`
Roles: company_admin, it_admin · Spec: [`device-status`][device-status]
Device counts for the rollout dashboard.
Request: none.
Response `200`: count per `status`, count per badge, and `healthy` (online with no badge). Shape: `{ status: { online, offline, deactivated, released }, badges: { outdated, permission_pending, browser_access_pending, paused, open_alert }, healthy }`, all int.
Errors: `403 FORBIDDEN` (manager).

### `POST /v1/devices/:id/deactivate`
Roles: company_admin, it_admin (user token) · Spec: [`device-lifecycle`][device-lifecycle]
Deactivate a device and free its seat. (The uninstaller's device-key call is in [agent-contract.md](agent-contract.md).)
Request: none.
Response `200`: the device as `GET /v1/devices/:id`.
Errors:

| status | code | when |
|---|---|---|
| 403 | `FORBIDDEN` | manager |
| 404 | `NOT_FOUND` | unknown or other company |
| 409 | `CONFLICT` | device is released |

Notes: sets `deactivated_at`, clears `key_hash`; the device's next call gets `401 DEVICE_REVOKED`. Repeating returns the device unchanged.

### `POST /v1/devices/:id/release`
Roles: company_admin, it_admin · Spec: [`device-lifecycle`][device-lifecycle]
Release a device from monitoring.
Request: none.
Response `200`: the device as `GET /v1/devices/:id`, `status` `released`.
Errors: `403 FORBIDDEN` (manager); `404 NOT_FOUND`; `409 CONFLICT` (already released).
Notes: sets `released_at`, keeps `key_hash`, frees the seat and ends the binding. The device then gets `401 DEVICE_RELEASED` with `released_at` and `upload_until` (+24 h); its key is still accepted on the upload routes for 7 days ([agent-contract.md](agent-contract.md), D45). It raises no offline alert and stays listed as `released`. Allowed on a deactivated device. There is no reassign route: a binding's employee never changes. To give the device to someone else, release it, then run WorkBeat Setup for the new employee, which makes a new binding and takes a seat (D48).

---

## Policy

Block rules, sensitive domains and the notice reach devices through `GET /v1/agents/policy`
([`agent-policy`][agent-policy]); productivity rules do not.

### `GET /v1/block-rules`
Roles: company_admin, it_admin, manager · Spec: [`block-rules`][block-rules]
The website block list.
Request: none.
Response `200`: array of `{ id: uuid, type: enum(domain|url), pattern: string, reason: string|null, created_at: ISO-8601 datetime }`.
Errors: none route-specific.

### `POST /v1/block-rules`
Roles: company_admin, it_admin · Spec: [`block-rules`][block-rules]
Add a block rule.
Request:

| field | type | required | notes |
|---|---|---|---|
| type | enum(domain\|url\|regex) | yes | `regex` is compiled to `url` rules, never stored |
| pattern | string | yes | `domain`: bare host name, stored lower case. `url`: Chrome URLBlocklist filter. `regex`: anchored literal host (optional `(www\.)?` or alternation of literal hosts) + literal path prefix + optional `.*` |
| reason | string | no | |

Response `201`: the rule; for `regex`, the created `url` rules (array).
Errors:

| status | code | when |
|---|---|---|
| 403 | `FORBIDDEN` | manager |
| 409 | `CONFLICT` | duplicate `(type, lower(pattern))` |
| 422 | `VALIDATION_FAILED` | invalid pattern for its type; regex that cannot be compiled |

Notes: sets `created_by`; raises `companies.policy_version`.

### `PATCH /v1/block-rules/:id`
Roles: company_admin, it_admin · Spec: [`block-rules`][block-rules]
Edit a block rule.
Request: `pattern` string, `reason` string; both optional.
Response `200`: the rule `{ id, type, pattern, reason, created_at }`.
Errors: `403 FORBIDDEN`; `404 NOT_FOUND`; `409 CONFLICT`; `422 VALIDATION_FAILED`.
Notes: raises `companies.policy_version`.

### `DELETE /v1/block-rules/:id`
Roles: company_admin, it_admin · Spec: [`block-rules`][block-rules]
Remove a block rule.
Request: none.
Response `204`.
Errors: `403 FORBIDDEN`; `404 NOT_FOUND`.
Notes: raises `companies.policy_version`.

### `GET /v1/sensitive-domains`
Roles: company_admin, manager · Spec: [`sensitive-domains`][sensitive-domains]
Domains the agents never log.
Request: none.
Response `200`: array of `{ id: uuid, pattern: string, is_default: bool, created_at: ISO-8601 datetime }`.
Errors: `403 FORBIDDEN` (it_admin).

### `POST /v1/sensitive-domains`
Roles: company_admin · Spec: [`sensitive-domains`][sensitive-domains]
Add a sensitive domain.
Request: `pattern` string, required; bare host name ≤ 253 characters, stored lower case, covers subdomains.
Response `201`: the row, `is_default` false.
Errors: `403 FORBIDDEN` (manager, it_admin); `409 CONFLICT` (duplicate `lower(pattern)`); `422 VALIDATION_FAILED` (scheme, path, wildcard, IP).
Notes: sets `created_by` (derived); raises `companies.policy_version`.

### `DELETE /v1/sensitive-domains/:id`
Roles: company_admin · Spec: [`sensitive-domains`][sensitive-domains]
Remove a sensitive domain, defaults included.
Request: none.
Response `204`.
Errors: `403 FORBIDDEN`; `404 NOT_FOUND`.
Notes: a removed default is never restored. Raises `companies.policy_version`.

### `GET /v1/productivity-rules`
Roles: company_admin, manager · Spec: [`productivity-rules`][productivity-rules]
Rules that label apps and domains in reports.
Request: none.
Response `200`: array of `{ id: uuid, match_type: enum(app|domain), pattern: string, category: enum(productive|neutral|unproductive) }`.
Errors: `403 FORBIDDEN` (it_admin).

### `POST /v1/productivity-rules`
Roles: company_admin · Spec: [`productivity-rules`][productivity-rules]
Add a productivity rule.
Request:

| field | type | required | notes |
|---|---|---|---|
| match_type | enum(app\|domain) | yes | |
| pattern | string | yes | `domain`: bare host name; `app`: non-empty app name or bundle ID |
| category | enum(productive\|neutral\|unproductive) | yes | |

Response `201`: the rule.
Errors: `403 FORBIDDEN` (manager, it_admin); `409 CONFLICT` (duplicate `(match_type, lower(pattern))`); `422 VALIDATION_FAILED`.
Notes: `created_by` set (derived, `0002`). No `policy_version` change.

### `PATCH /v1/productivity-rules/:id`
Roles: company_admin · Spec: [`productivity-rules`][productivity-rules]
Change a rule's category.
Request: `category` enum(productive\|neutral\|unproductive), required.
Response `200`: the rule `{ id, match_type, pattern, category }`.
Errors: `403 FORBIDDEN`; `404 NOT_FOUND`; `422 VALIDATION_FAILED`.
Notes: re-categorises history in every later report; no `policy_version` change, no activity row written.

### `DELETE /v1/productivity-rules/:id`
Roles: company_admin · Spec: [`productivity-rules`][productivity-rules]
Remove a productivity rule.
Request: none.
Response `204`.
Errors: `403 FORBIDDEN`; `404 NOT_FOUND`.

### `GET /v1/settings/notice`
Roles: company_admin · Spec: [`collection-notice`][collection-notice]
The collection notice employees acknowledge.
Request: none.
Response `200`: `notice_text` string, `notice_version` int.
Errors: `403 FORBIDDEN` (manager, it_admin).

### `PUT /v1/settings/notice`
Roles: none (every company role gets `403 FORBIDDEN`; staff-managed, B29) · Spec: [`collection-notice`][collection-notice]
Edit the notice text.
Request: `notice_text` string, required; non-empty, within the `packages/shared` limit.
Response `200`: `{ notice_text, notice_version }`.
Errors: `403 FORBIDDEN`; `422 VALIDATION_FAILED` (empty or too long; notice unchanged).
Notes: a changed text raises `notice_version` by one and `companies.policy_version`, same transaction. Same text changes neither.

---

## Alerts

### `GET /v1/alerts`
Roles: company_admin, it_admin (all devices), manager (devices of own team) · Spec: [`alerts-feed`][alerts-feed]
Tamper and offline events, newest `occurred_at` first.
Query (all optional):

| field | type | required | notes |
|---|---|---|---|
| type | array<enum(process_restart\|hosts_modified\|config_changed\|clock_tampered\|permission_revoked\|offline\|duplicate_device_id)> | no | one or more, comma-separated: `type=hosts_modified,offline` |
| state | enum(open\|resolved) | no | |
| device_id | uuid | no | |
| employee_id | uuid | no | events of that employee's devices |
| q | string | no | ≤ 100 characters; literal, case-insensitive match on event type, hostname, employee name or detail |
| from | ISO-8601 datetime | no | type (derived) |
| to | ISO-8601 datetime | no | type (derived) |
| cursor | string | no | the previous page's `next_cursor` |

Response `200`: `{ items, next_cursor, counts }`. `items`: at most the `packages/shared` page size (50); `next_cursor`: string or `null`; `counts`: `{ <event_type>: int }` for the same filters without `type` and `cursor`. Each item:

| field | type | notes |
|---|---|---|
| id | uuid | |
| event_type | enum(as `type`) | |
| device_id | uuid | |
| hostname | string | snapshot at the event |
| employee | object | `{ id, name }` of the device's employee; key name (derived) |
| detail | object | |
| repeat_count | int | ≥ 1 |
| occurred_at | ISO-8601 datetime | |
| received_at | ISO-8601 datetime | |
| resolved_at | ISO-8601 datetime \| null | |
| resolved_by | uuid \| null | null when a heartbeat closed an `offline` |
| resolved_by_name | string \| null | the resolver's name |

Errors: none route-specific.
Notes: an event is listed as soon as the request or job that stored it commits; no push.

### `POST /v1/alerts/:id/resolve`
Roles: company_admin, it_admin · Spec: [`alerts-feed`][alerts-feed]
Close an alert.
Request: none.
Response `200`: the event, fields as in `GET /v1/alerts` items.
Errors: `403 FORBIDDEN` (manager); `404 NOT_FOUND`.
Notes: sets `resolved_at`, `resolved_by`. Repeating returns it unchanged. With no open tamper event left the device loses the `open_alert` badge.

---

## Screenshots

### `GET /v1/employees/:id/screenshots`
Roles: company_admin, manager (own team) · Spec: [`screenshot-access`][screenshot-access]
A range of company days, newest first, in pages.
Query:

| field | type | required | notes |
|---|---|---|---|
| from | string `YYYY-MM-DD` | yes¹ | inclusive, company `timezone`; moved up to the first retained day |
| to | string `YYYY-MM-DD` | yes¹ | inclusive; the range is at most 90 days (`to` at most 89 days after `from`) |
| date | string `YYYY-MM-DD` | — | shorthand for `from=date&to=date` |
| start, end | string `HH:MM` | no² | hours of every day in the range, company `timezone`: `start` inclusive, `end` exclusive; `start` 00:00–23:59, `end` up to `24:00` and after `start` |
| limit | int | no | 1–60, default 24. Every tile loads the full JPEG, so pages stay small |
| cursor | string | no | `next_cursor` of the previous page |

¹ Or `date`.
² Both or neither; neither means the whole day. `total` and paging count only the screenshots inside the hours.

Response `200`:

| field | type | notes |
|---|---|---|
| screenshots_enabled | bool | false while `screenshot_tier` is `off` |
| from, to | string `YYYY-MM-DD` | the range used (`from` after the retention clamp) |
| total | int | `uploaded` screenshots in the whole range, whatever the page; 0 when disabled |
| next_cursor | string \| null | opaque; `null` on the last page |
| items | array<object> | `uploaded` only, newest first (ties by `id`); empty when disabled. Key `items` |
| items[].id | uuid | |
| items[].captured_at | ISO-8601 datetime | |
| items[].device_id | uuid | |
| items[].hostname | string | |
| items[].view_url | string | R2 presigned, 5 minutes (`packages/shared`); for `<img>` |
| items[].thumb_url | string \| null | same expiry; a small JPEG for timeline tiles, `null` when the agent sent none (then use `view_url`) |
| items[].download_url | string | same object and expiry; R2 answers it as `attachment; filename="<hostname>-<YYYY-MM-DD>-<HHMM>.jpg"` (company time), `image/jpeg`. No CORS needed |
| items[].expires_at | ISO-8601 datetime | |

Errors: `403 FORBIDDEN` (it_admin); `404 NOT_FOUND` (outside team or other company; no URL issued); `422 VALIDATION_FAILED` (bad or reversed dates, range over 90 days, `start`/`end` alone, malformed or not in order, `limit`, `cursor`).
Notes: signed URLs are issued only for the page returned, and none while the tier is `off`. URLs never logged.

---

## Reports

All four report routes share these rules ([`usage-reports`][usage-reports]):

Roles: company_admin (every employee), manager (own team).
Common query:

| field | type | required | notes |
|---|---|---|---|
| from | string `YYYY-MM-DD` | yes | inclusive, company `timezone` |
| to | string `YYYY-MM-DD` | yes | inclusive |
| employee_id | uuid | no | at most one of these three; none = caller's whole scope |
| manager_user_id | uuid | no | a manager may pass only their own ID |
| department | string | no | |

Every response carries the effective `from` and `to` (a `from` before retention moves to the first retained day). Periods with no rows, paused ones included, count as zero.
Without `employee_id`, totals (and exports) count only employees who are not archived; with `employee_id` an archived employee's history is still returned. The dashboard's `today` follows the same rule.
Common errors:

| status | code | when |
|---|---|---|
| 403 | `FORBIDDEN` | it_admin; manager passing another `manager_user_id` |
| 404 | `NOT_FOUND` | `employee_id` outside the caller's scope |
| 422 | `VALIDATION_FAILED` | malformed date, `to` before `from`, range over 90 days |

Productivity is resolved at read time: app sessions by `app_name` (`match_type` `app`), URL visits by `domain`, case-insensitive; no match = `neutral`.

### `GET /v1/reports/apps`
Roles: company_admin, manager · Spec: [`usage-reports`][usage-reports]
Top apps by foreground time.
Query: common, plus `limit` int (default 10, max 100), `offset` int (0–100000, default 0), `category` enum(productive|neutral|unproductive) (optional; ranks, limits and pages only that category).
Response `200`: `from`, `to`, and apps ranked by `seconds`, ties by `app_name`: `{ app_name: string, seconds: int, category: enum(productive|neutral|unproductive) }`. List key `apps`. `next_offset` int \| null: the next page's `offset`, `null` on the last page.
Errors: common.

### `GET /v1/reports/websites`
Roles: company_admin, manager · Spec: [`usage-reports`][usage-reports]
Top domains by visit time.
Query: common, plus `limit` int (default 10, max 100), `offset` int (0–100000, default 0), `category` enum(productive|neutral|unproductive) (optional; ranks, limits and pages only that category).
Response `200`: `from`, `to`, and domains ranked by `seconds`, ties by `domain`: `{ domain: string, seconds: int, category }`. List key `websites`. `next_offset` int \| null: the next page's `offset`, `null` on the last page.
Errors: common.

### `GET /v1/reports/activity`
Roles: company_admin, manager · Spec: [`usage-reports`][usage-reports]
Tracked time, activity percent and idle time.
Query: common.
Response `200`:

| field | type | notes |
|---|---|---|
| from, to | string `YYYY-MM-DD` | effective range |
| tracked_seconds | int | sum of `app_sessions.duration_seconds`; idle not subtracted |
| activity_percent | number \| null | Σ`active_samples` / Σ`total_samples`; null without samples |
| idle_seconds | int | from `idle_intervals` |
| hours | array<object> (24) | hour of day in company `timezone`, tracked time and activity percent averaged over days with data. `hours: [{ hour (0–23), tracked_seconds, activity_percent }]` |

Errors: common.

### `GET /v1/reports/productivity`
Roles: company_admin, manager · Spec: [`usage-reports`][usage-reports]
Productive / neutral / unproductive split.
Query: common.
Response `200`: `from`, `to`, `productive_seconds`, `neutral_seconds`, `unproductive_seconds`, `tracked_seconds` (all int).
Errors: common.
Notes: browser-app sessions (list in `packages/shared`) are replaced by their URL visits, so browser time counts once, by site.

### `GET /v1/employees/:id/calendar`
Roles: company_admin, manager (own team) · Spec: [`calendar-and-timesheets`][calendar-and-timesheets]
One row per day for a day, Monday-start week or month.
Query:

| field | type | required | notes |
|---|---|---|---|
| view | enum(day\|week\|month) | yes | |
| date | string `YYYY-MM-DD` | yes | |

Response `200`: array of rows (days outside retention omitted; zero on days without data):

| field | type | notes |
|---|---|---|
| date | string `YYYY-MM-DD` | company `timezone`; a row counts on the day it started |
| tracked_seconds | int | |
| activity_percent | number \| null | |
| productive_seconds, neutral_seconds, unproductive_seconds | int | |
| paused | bool | a non-cancelled pause overlaps the day |

Errors: `403 FORBIDDEN` (it_admin); `404 NOT_FOUND`; `422 VALIDATION_FAILED`.

### `GET /v1/employees/:id/timesheet`
Roles: company_admin, manager (own team) · Spec: [`calendar-and-timesheets`][calendar-and-timesheets]
One employee's Monday-start week.
Query: `week` string `YYYY-MM-DD`, required, must be a Monday.
Response `200`: employee `name` and `email`, company `name`, seven day rows (`date`, `first_activity_at`, `last_activity_at`, `tracked_seconds`, `activity_percent`, `productive_seconds`, `neutral_seconds`, `unproductive_seconds`, `paused`), and week totals, as `{ employee: { name, email }, company: { name }, week, days: [ …7 rows… ], totals: { tracked_seconds, activity_percent, productive_seconds, neutral_seconds, unproductive_seconds } }`.
Errors: `403 FORBIDDEN` (it_admin); `404 NOT_FOUND`; `422 VALIDATION_FAILED` (`week` not a Monday).

### `GET /v1/employees/:id/timesheet.pdf`
Roles: company_admin, manager (own team) · Spec: [`calendar-and-timesheets`][calendar-and-timesheets]
The timesheet as a PDF.
Query: `week` as above.
Response `200`: `Content-Type: application/pdf`, `Content-Disposition` file name with employee and week. Not enveloped.
Errors: as the JSON timesheet.
Notes: generated per request from the JSON values; never stored.

---

## Exports

All three take the [report](#reports) query (range and scope, validated and clamped the same way),
return UTF-8 CSV with a header row, `Content-Type: text/csv` and a `Content-Disposition` file name
(not enveloped). Every row carries employee name and email; times are ISO 8601 with the company
`timezone` offset. Cells starting with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'`; cells with
a comma, quote or line break are quoted ([`data-export`][data-export]).

Roles: company_admin (all employees), manager (own team; no scope parameter = own team).
Common errors: report errors, plus `403 FORBIDDEN` (it_admin) and `422 EXPORT_TOO_LARGE` (over the
`packages/shared` row cap, with the cap; no partial file).

### `GET /v1/exports/app-sessions.csv`
Roles: company_admin, manager · Spec: [`data-export`][data-export]
Raw app sessions.
Query: report query.
Response `200`: CSV rows with employee name, email, productivity `category` (resolved at export), and session columns (derived from `app_sessions`): `app_name`, `bundle_id`, `process_name`, `window_title`, `started_at`, `ended_at`, `duration_seconds`.
Errors: common.

### `GET /v1/exports/url-visits.csv`
Roles: company_admin, manager · Spec: [`data-export`][data-export]
Raw URL visits.
Query: report query.
Response `200`: CSV rows with employee name, email, `category`, and visit columns (derived from `url_visits`): `browser`, `url`, `domain`, `visited_at`, `duration_seconds`.
Errors: common.

### `GET /v1/exports/daily-summaries.csv`
Roles: company_admin, manager · Spec: [`data-export`][data-export]
One row per employee per day.
Query: report query.
Response `200`: CSV rows with employee name, email, date, tracked seconds, activity percent, productive, neutral and unproductive seconds. Columns: `employee_name, employee_email, date, tracked_seconds, activity_percent, productive_seconds, neutral_seconds, unproductive_seconds`.
Errors: common.

---

## Dashboard

### `GET /v1/dashboard`
Roles: company_admin, manager, it_admin · Spec: [`dashboard-summary`][dashboard-summary]
The dashboard in one call; sections depend on role.
Request: none.
Response `200`:

| field | type | notes |
|---|---|---|
| devices | object | `{ online: int, offline: int, open_alert: int }`, released and deactivated excluded; `open_alert` counts devices with that badge, which are also online or offline. Manager: own team's devices only |
| today | object | company_admin, manager only: `{ tracked_seconds: int, activity_percent: number\|null }` since local midnight |
| alerts | array<object> | newest five the caller would see in `GET /v1/alerts`, same fields and scoping |
| seats | object | company_admin only: `{ used: int, limit: int\|null }` |

Errors: none route-specific.
Notes: `it_admin` gets `devices` and `alerts` only.

---

## Unspecified

Nothing is left open (round 3 of the WorkBeat Admin requests, 16 Nov 2026). Settled here:

- **Write responses:** as stated on each route above: `201` create with the record, `200` update or
  action with the record, `204` delete.
- **`GET /v1/employees/:id` for `it_admin`:** the same four fields as the list (`id`, `name`,
  `email`, `department`), B18.
- **Resend or cancel of an invitation that is not open:** resend → `409 CONFLICT`; cancel of a
  revoked one → `204` (first `revoked_at` kept), of an accepted one → `409 CONFLICT`.
- **Lists:** returned whole, no paging or sort parameters, except `GET /v1/alerts` (cursor) and the
  filters each route lists ([`api-envelope`](../../openspec/changes/establish-api-foundation/specs/api-envelope/spec.md)).
- **Portal writes while suspended or expired:** never refused for billing
  ([`company-status`](../../openspec/changes/provision-companies/specs/company-status/spec.md)).
- **`EXPORT_TOO_LARGE`:** `422` with `cap` (the row limit, 100,000).
- **Not built yet:** Stripe billing writes (`PUT /v1/billing/screenshot-tier`, `POST /v1/billing/portal-session`). TLS certificates for customer domains (Q15): an approved custom domain works locally over http only.

[user-authentication]: ../../openspec/changes/authenticate-users/specs/user-authentication/spec.md
[role-access]: ../../openspec/changes/authenticate-users/specs/role-access/spec.md
[staff-accounts]: ../../openspec/changes/authenticate-users/specs/staff-accounts/spec.md
[team-invitations]: ../../openspec/changes/authenticate-users/specs/team-invitations/spec.md
[company-status]: ../../openspec/changes/provision-companies/specs/company-status/spec.md
[subscription-sync]: ../../openspec/changes/provision-companies/specs/subscription-sync/spec.md
[license-key]: ../../openspec/changes/provision-companies/specs/license-key/spec.md
[company-settings]: ../../openspec/changes/configure-company/specs/company-settings/spec.md
[custom-domains]: ../../openspec/changes/configure-company/specs/custom-domains/spec.md
[change-approvals]: ../../openspec/changes/approve-it-admin-changes/specs/change-approvals/spec.md
[installer-downloads]: ../../openspec/changes/distribute-agents/specs/installer-downloads/spec.md
[agent-updates]: ../../openspec/changes/distribute-agents/specs/agent-updates/spec.md
[agent-releases]: ../../openspec/changes/distribute-agents/specs/agent-releases/spec.md
[employee-directory]: ../../openspec/changes/manage-employees/specs/employee-directory/spec.md
[manager-teams]: ../../openspec/changes/manage-employees/specs/manager-teams/spec.md
[monitoring-settings]: ../../openspec/changes/manage-employees/specs/monitoring-settings/spec.md
[monitoring-pauses]: ../../openspec/changes/manage-employees/specs/monitoring-pauses/spec.md
[notice-acknowledgement]: ../../openspec/changes/receive-device-health/specs/notice-acknowledgement/spec.md
[device-status]: ../../openspec/changes/receive-device-health/specs/device-status/spec.md
[device-lifecycle]: ../../openspec/changes/enroll-devices/specs/device-lifecycle/spec.md
[agent-policy]: ../../openspec/changes/serve-agent-policy/specs/agent-policy/spec.md
[block-rules]: ../../openspec/changes/serve-agent-policy/specs/block-rules/spec.md
[sensitive-domains]: ../../openspec/changes/serve-agent-policy/specs/sensitive-domains/spec.md
[productivity-rules]: ../../openspec/changes/serve-agent-policy/specs/productivity-rules/spec.md
[collection-notice]: ../../openspec/changes/serve-agent-policy/specs/collection-notice/spec.md
[alerts-feed]: ../../openspec/changes/process-tamper-alerts/specs/alerts-feed/spec.md
[screenshot-access]: ../../openspec/changes/ingest-activity/specs/screenshot-access/spec.md
[usage-reports]: ../../openspec/changes/report-usage/specs/usage-reports/spec.md
[calendar-and-timesheets]: ../../openspec/changes/report-usage/specs/calendar-and-timesheets/spec.md
[data-export]: ../../openspec/changes/report-usage/specs/data-export/spec.md
[dashboard-summary]: ../../openspec/changes/report-usage/specs/dashboard-summary/spec.md
