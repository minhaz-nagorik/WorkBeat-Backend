# Staff API

`/v1/staff/*` routes for WorkBeat staff (`super_admin`) in the web platform's staff area.
Conventions, auth and the code catalog are in [README.md](README.md).

**Applies to every route below; not repeated per route:**

- `Authorization: Bearer <session token>` of a `super_admin` from `POST /v1/auth/login`; missing, bad or disabled →
  `401 UNAUTHENTICATED`.
- Sign-in: `POST /v1/auth/login { email, password }` → `{ token, expires_at, user }`, as for company users; there is no MFA (removed 16 Nov 2026, B23) ([`staff-accounts`][staff-accounts]).
- Every company role (`company_admin`, `manager`, `it_admin`) → `403 FORBIDDEN` ([`role-access`][role-access]).
- `400`/`422 VALIDATION_FAILED`, `429 RATE_LIMITED`, `500 INTERNAL`.
- Runs in `staff` scope, no `app.company_id`; reads only `companies`, `licenses`, `users`,
  `invitations`, `agent_releases`, `stripe_events` and `company_seat_counts()`. No response holds an
  employee name or email, a device hostname, serial or hardware ID, an app, title, URL, domain,
  screenshot path or signed URL, or any activity value ([`staff-data-boundary`][staff-data-boundary]).
  CI calls every staff route with a seeded tenant and fails the build on any leak.
- There is no impersonation: no route issues a token, session or link acting as another user, and a
  `super_admin` gets `403 FORBIDDEN` on every company route.

Contents: [Session](#session) · [Staff team](#staff-team) · [Companies](#companies) ·
[Licences](#licences) · [Agent releases](#agent-releases) · [Unspecified](#unspecified)

---

## Session

### `GET /v1/me`
Roles: super_admin (also company roles, see [portal-api.md](portal-api.md#get-v1me)) · Spec: [`user-authentication`][user-authentication], [`staff-accounts`][staff-accounts]
Who the staff member is.
Request: none.
Response `200`: `id` uuid, `email` string, `name` string, `role` `super_admin`, `company` `null`.
Errors: `401 UNAUTHENTICATED`.
Runs in `staff` scope. A `super_admin` token must carry no `company_id`.

Staff accept their invitation through `POST /v1/invitations/accept`
([portal-api.md](portal-api.md#post-v1invitationsaccept)); it creates a `users` row with no `company_id`.
No sign-up route, Stripe event or company invitation creates a `super_admin`; the first one is made
by an operator script outside the API.

---

## Staff team

### `GET /v1/staff/team`
Roles: super_admin · Spec: [`staff-accounts`][staff-accounts]
Staff users and open staff invitations.
Request: none.
Response `200`:

| field | type | notes |
|---|---|---|
| users | array<object> | `users` with role `super_admin` only: `{ id, name, email, created_at, disabled_at }` (derived). Key name (derived) |
| invitations | array<object> | open staff invitations: `{ id, email, created_at, expires_at }` (derived). Key name (derived) |

Errors: none route-specific.
Notes: no company user appears.

### `POST /v1/staff/invitations`
Roles: super_admin · Spec: [`staff-accounts`][staff-accounts]
Invite a colleague to the staff area.
Request:

| field | type | required | notes |
|---|---|---|---|
| email | string | yes | |

Response `201`: `{ id, email, role, expires_at }`. Open invitation or existing user for the email → `409 CONFLICT`.
Errors: `403 FORBIDDEN` (company roles).
Notes: inserts `invitations` with `company_id` NULL, `role` `super_admin`, `invited_by` = caller, then emails the link.

### `DELETE /v1/staff/invitations/:id`
Roles: super_admin · Spec: [`staff-accounts`][staff-accounts]
Cancel a staff invitation.
Request: none.
Response `204`.
Errors: `404 NOT_FOUND` (derived from [`role-access`][role-access]: unknown ID).
Notes: sets `revoked_at`.

### `DELETE /v1/staff/users/:id`
Roles: super_admin · Spec: [`staff-accounts`][staff-accounts]
Remove a staff member.
Request: none.
Response `204`.
Errors:

| status | code | when |
|---|---|---|
| 404 | `NOT_FOUND` | unknown ID (derived) |
| 409 | `CONFLICT` | the caller themselves, or the last enabled `super_admin` |

Notes: sets `disabled_at` and ends the user's sessions.

---

## Companies

### `GET /v1/staff/companies`
Roles: super_admin · Spec: [`staff-companies`][staff-companies]
Every customer company with plan, seats, tier, status and revenue estimate.
Query:

| field | type | required | notes |
|---|---|---|---|
| status | enum(trial\|active\|suspended\|expired) | no | |
| q | string | no | literal, case-insensitive match on `name`, `slug` or `key_last4` |

Response `200`: the rows plus totals.

| field | type | notes |
|---|---|---|
| id | uuid | |
| name | string | |
| slug | string | |
| plan | enum(starter\|growth\|enterprise) | |
| seat_limit | int \| null | null = unlimited |
| seats_used | int | from `company_seat_counts()`, never `devices` |
| screenshot_tier | enum(off\|light\|standard\|intensive) | |
| status | enum(trial\|active\|suspended\|expired) | |
| suspended_reason | enum(payment_failed\|staff) \| null | |
| custom_domain | string \| null | |
| custom_domain_status | enum(pending\|active\|failed) \| null | |
| trial_ends_at | ISO-8601 datetime \| null | |
| created_at | ISO-8601 datetime | |
| mrr_estimate | number | `active`: `seats_used` × ($1.00 + tier add-on: off 0, light 0.50, standard 1.00, intensive 2.00); 0 for trial, suspended, expired. An estimate; invoices stay in Stripe |
| key_last4 | string | |
| expired_blocking_grace_days | int | |
| custom_domain_checked_at | ISO-8601 datetime \| null | |

The body is `{ items: [ …rows above… ], totals: { companies, seats_used, mrr_estimate, suspended } }`,
newest company first, not paged.

Errors: none route-specific.

### `GET /v1/staff/companies/:id`
Roles: super_admin · Spec: [`staff-companies`][staff-companies]
One company.
Request: none.
Response `200`: one row as in the list (no totals).
Errors: `404 NOT_FOUND` (derived).
Notes: carries no employee, device or activity field.

### `POST /v1/staff/companies/:id/suspend`
Roles: super_admin · Spec: [`staff-companies`][staff-companies]
Suspend a company.
Request: none.
Response `200`: the company row as in the list.
Errors: `404 NOT_FOUND` (derived); `409 CONFLICT` (company is `expired`; nothing changes).
Notes: sets `status` `suspended`, `suspended_reason` `staff`, `suspended_at`, also over a `payment_failed` suspension. A later `invoice.paid` leaves it suspended. Its agents then get `402 COMPANY_SUSPENDED`, the Downloader `402 LICENSE_SUSPENDED`.

### `POST /v1/staff/companies/:id/restore`
Roles: super_admin · Spec: [`staff-companies`][staff-companies]
Lift a suspension.
Request: none.
Response `200`: the company row as in the list.
Errors: `404 NOT_FOUND` (derived); `409 CONFLICT` (company is `expired`; nothing changes).
Notes: sets `status` `trial` while `trial_ends_at` is ahead, else `active`; clears `suspended_reason`.

### `PATCH /v1/staff/companies/:id`
Roles: super_admin · Spec: [`staff-companies`][staff-companies], [`company-status`][company-status]
Set the expired-licence blocking grace.
Request:

| field | type | required | notes |
|---|---|---|---|
| expired_blocking_grace_days | int | yes | 0–365 |

Response `200`: the company row as in the list.
Errors: `404 NOT_FOUND` (derived); `422 VALIDATION_FAILED` (outside 0–365).
Notes: applies at once: `blocking_ends_at` = `licenses.expired_at` + grace is computed on every read.

---

## Licences

### `PATCH /v1/staff/companies/:id/license`
Roles: super_admin · Spec: [`staff-companies`][staff-companies]
Enterprise plan and seat-limit override.
Request:

| field | type | required | notes |
|---|---|---|---|
| plan | enum(enterprise) | yes | |
| seat_limit | int \| null | yes | null = unlimited |

Response `200`: the company row as in the list. Moving a `starter` or `growth` licence to `enterprise` is allowed.
Errors:

| status | code | when |
|---|---|---|
| 404 | `NOT_FOUND` | unknown company (derived) |
| 409 | `CONFLICT` | `seat_limit` below seats used; `seat_limit` change on a `starter` or `growth` licence. Nothing changes |

Notes: later `customer.subscription.updated` events leave an `enterprise` `seat_limit` unchanged ([`subscription-sync`][subscription-sync]).

### `POST /v1/staff/companies/:id/license/reissue`
Roles: super_admin · Spec: [`staff-license-reissue`][staff-license-reissue]
Replace a leaked licence key.
Request: none.
Response: `key` string (`WB-XXXX-XXXX-XXXX-XXXX`), returned once, with `Cache-Control: no-store`. Status `200`: `{ key }`.
Errors: `404 NOT_FOUND` (derived).
Notes:
- On the existing `licenses` row (same `id`, no second row): new `key_hash`, `key_ciphertext`, `key_last4`, and `key_reset_at`.
- Same transaction: deletes every unused (`used_at` NULL) `enrollment_tokens` row of the licence through `delete_unused_enrollment_tokens`; used tokens stay.
- The old key at `/v1/license/validate` answers `404 LICENSE_NOT_FOUND`; a deleted token at `/v1/devices/enroll` answers `404 ENROLLMENT_TOKEN_INVALID`.
- No `devices` row changes; seats used are the same; enrolled devices keep working.
- After commit, emails the new key through Resend to every enabled `company_admin`. The key is never logged.

---

## Agent releases

### `GET /v1/staff/agent-releases`
Roles: super_admin · Spec: [`agent-releases`][agent-releases]
Every release, newest first.
Request: none.
Response `200`: array<object> (fields derived from `agent_releases` unless noted):

| field | type | notes |
|---|---|---|
| id | uuid | (derived) |
| product | enum(agent\|downloader) | (derived) |
| platform | enum(macos\|windows) | (derived) |
| arch | enum(universal\|x64\|arm64) | (derived) |
| version | string | `x.y.z` (derived) |
| min_supported | string | `x.y.z` (derived) |
| storage_path | string | (derived) |
| sha256 | string | (derived) |
| signature | string \| null | (derived) |
| size_bytes | int | (derived) |
| release_notes | string \| null | (derived) |
| published_by | uuid | (derived) |
| released_at | ISO-8601 datetime | (derived) |
| withdrawn_at | ISO-8601 datetime \| null | named by the spec |

Errors: none route-specific.

### `POST /v1/staff/agent-releases`
Roles: super_admin · Spec: [`agent-releases`][agent-releases]
Publish an agent or Downloader package.
Request:

| field | type | required | notes |
|---|---|---|---|
| product | enum(agent\|downloader) | yes | |
| platform | enum(macos\|windows) | yes | |
| arch | enum(universal\|x64\|arm64) | yes | `macos` → `universal`; `windows` → `x64` or `arm64` |
| version | string | yes | `x.y.z` |
| min_supported | string | yes | `x.y.z`, not above `version` |
| storage_path | string | yes | object in the private `agents` bucket |
| sha256 | string | yes | |
| signature | string \| null | macOS: yes | Windows MSIs are unsigned (W35): `null` or omitted; `''` → `422` |
| size_bytes | int | yes | must match the stored object |
| release_notes | string | no | (derived) nullable |

Response `201`: the release; fields (derived) as in the list.
Errors:

| status | code | when |
|---|---|---|
| 403 | `FORBIDDEN` | company roles |
| 409 | `CONFLICT` | `(product, platform, arch, version)` exists |
| 422 | `VALIDATION_FAILED` | object missing or `size_bytes` differs; arch wrong for platform; `min_supported` above `version` |

Notes: sets `published_by` = caller. An `agent` release raises every company's `policy_version`, so devices fetch the new `min_agent_version` and update package. Global minimum per platform = greatest `min_supported` among live `agent` releases with that platform's highest `version`.

### `POST /v1/staff/agent-releases/:id/withdraw`
Roles: super_admin · Spec: [`agent-releases`][agent-releases]
Pull a broken release.
Request: none.
Response `200`: the release.
Errors: `404 NOT_FOUND` (derived).
Notes: sets `withdrawn_at`; withdrawing again returns it unchanged. A withdrawn release is never offered for download or update; the newest live one is. Withdrawing an `agent` release raises every company's `policy_version`.

---

## Unspecified

Nothing is left open; the staff API is specified but **not built yet**. Settled (16 Nov 2026):

- **Staff team:** `GET /v1/staff/team` → `{ users: [{ id, name, email, created_at }], invitations: [{ id, email, created_at, expires_at }] }`.
- **Staff invitation accept:** `201 { user }`, no session; the person then signs in with their password.
- **Resend:** `POST /v1/staff/invitations/:id/resend` → `200 { id, email, role, expires_at }`, same codes as the company team's resend.
- **Upload URL:** `POST /v1/staff/agent-releases/upload-url { product, platform, arch, version }` → `200 { upload_url, storage_path, expires_at }`.
- **404:** every staff route answers `404 NOT_FOUND` for an ID of no row of its kind ([`staff-companies`][staff-companies]).

[user-authentication]: ../../openspec/changes/authenticate-users/specs/user-authentication/spec.md
[role-access]: ../../openspec/changes/authenticate-users/specs/role-access/spec.md
[staff-accounts]: ../../openspec/changes/authenticate-users/specs/staff-accounts/spec.md
[staff-companies]: ../../openspec/changes/administer-platform/specs/staff-companies/spec.md
[staff-data-boundary]: ../../openspec/changes/administer-platform/specs/staff-data-boundary/spec.md
[staff-license-reissue]: ../../openspec/changes/administer-platform/specs/staff-license-reissue/spec.md
[company-status]: ../../openspec/changes/provision-companies/specs/company-status/spec.md
[subscription-sync]: ../../openspec/changes/provision-companies/specs/subscription-sync/spec.md
[agent-releases]: ../../openspec/changes/distribute-agents/specs/agent-releases/spec.md
