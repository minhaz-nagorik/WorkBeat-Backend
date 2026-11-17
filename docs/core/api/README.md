# WorkBeat API reference

What every client of the WorkBeat backend calls, and what it gets back. The OpenSpec changes in
[`docs/openspec/changes/`](../../openspec/changes/) are the source of truth; these pages only collect
them. A field marked **(derived)** is named by no spec and was read from the schema
([`0001_init.sql`](../../../db/migrations/0001_init.sql), [`0002_spec_gaps.sql`](../../../db/migrations/0002_spec_gaps.sql),
[data-model.md](../architecture/data-model.md)). Anything no spec settles is listed under
**Unspecified** at the end of each page.

| Page | Covers |
|---|---|
| [agent-contract.md](agent-contract.md) | Mac and Windows agents, the Downloader and the uninstaller: `/v1/license/validate`, `/v1/devices/enroll`, `/v1/agents/*`, device-key `POST /v1/devices/:id/deactivate` |
| [portal-api.md](portal-api.md) | Company routes for `company_admin`, `manager` and `it_admin` (WorkBeat Admin) |
| [staff-api.md](staff-api.md) | `/v1/staff/*` for `super_admin`, and `GET /v1/me` for staff |
| [webhooks-and-cron.md](webhooks-and-cron.md) | `POST /v1/webhooks/stripe`, every `/cron/*` job, `GET /health` |

## Conventions

### Base path

Every route is under `/v1`, except `GET /health` and `POST /cron/<job>`, which the specs name without
it ([`schema-migrations`][schema-migrations], [`cron-routes`][cron-routes]).

### Envelope

Every JSON response is `{ "data": … }` on success or `{ "error": "<message>", "code": "<CODE>" }` on
failure. Clients branch on HTTP status and `code`, never on `error`. A response with no body is `204`
or `304` ([`api-envelope`][api-envelope]).

Success statuses, unless a route names its own: `201` with the record for a create, `200` with the
record for a read, update or action, `204` with no body for a delete.

- An unexpected failure is `500 INTERNAL` with a generic message: no stack trace, SQL, table name or
  request value.
- Body, query and path are validated before the route runs: malformed → `400 VALIDATION_FAILED`,
  well-formed but wrong → `422 VALIDATION_FAILED`, both naming the failing fields and writing nothing.
  Unknown body fields are ignored and never stored.
- A body over its route's limit (`packages/shared`) is `413 PAYLOAD_TOO_LARGE` before parsing.
- `402 LICENSE_EXPIRED` carries `blocking_ends_at` in the error body beside `error` and `code`.

### Headers on every response

| Header | Meaning |
|---|---|
| `Date` | Server clock. Agents anchor pause ends and `blocking_ends_at` to it |
| `X-Request-Id` | Echoes the request's `X-Request-Id`, or a generated one |
| `Retry-After` | Seconds, on `429` only |
| `Cache-Control: no-store` | On responses that return a licence key (`POST /v1/license/reveal`, staff reissue) |

### Authentication

| Caller | Header | Resolves to |
|---|---|---|
| Company user, staff | `Authorization: Bearer <session token>` (`wbs_…` from `POST /v1/auth/login`, 7 days, B22) | role and company from the session's enabled `users` row, never from the request ([`user-authentication`][user-authentication]) |
| Staff (`super_admin`) | Same; login returns the session as for company users, no MFA (B23 removed) | role `super_admin`, `company` null ([`staff-accounts`][staff-accounts]) |
| Downloader | `X-License-Key` | See [agent-contract.md](agent-contract.md) |
| Agent at enrollment | `Authorization: Bearer <enrollment token>` | See [agent-contract.md](agent-contract.md) |
| Agent, uninstaller | `X-Device-Key` | See [agent-contract.md](agent-contract.md) |
| Stripe | `Stripe-Signature` | [webhooks-and-cron.md](webhooks-and-cron.md) |
| Scheduler | `X-Cron-Secret` | [webhooks-and-cron.md](webhooks-and-cron.md) |
| Nobody | — | `POST /v1/invitations/lookup`, `POST /v1/invitations/accept`, `GET /v1/hosts/resolve`, `GET /health` |

Rules that hold on every user route:

- **Tenant from the credential.** `company_id` comes from the token (or device key, licence key, host
  name), never from a body, query or path ([`request-scope`][request-scope]). A company user runs in
  `tenant` scope; a `super_admin` in `staff` scope with no company.
- **Roles are checked before data is read.** A role a route does not allow gets `403 FORBIDDEN`. A
  `super_admin` gets `403 FORBIDDEN` on every company route; every company role gets `403 FORBIDDEN`
  on every `/v1/staff/*` route ([`role-access`][role-access]).
- **Another company's ID answers `404 NOT_FOUND`**, the same as an ID that does not exist.
- **Managers see only their team**: employees whose `manager_user_id` is the caller, and every row
  keyed by those employees. Anyone else is `404` and is left out of lists. Managers write nothing in
  employee, monitoring or pause data.
- A disabled user, a missing `users` row, or a token whose role or company differs from `users` gets
  `401 UNAUTHENTICATED`, even before the token expires.

### Rate limits

Per device key, licence key, user, and client IP for unauthenticated routes, with limits in
`packages/shared`. Over the limit: `429 RATE_LIMITED` with `Retry-After`, and the request is not
processed ([`rate-limiting`][rate-limiting]).

### Pagination

Only `GET /v1/alerts` is paged: it takes a cursor and returns at most the page size in
`packages/shared` with the next cursor ([`alerts-feed`][alerts-feed]). Pass the previous answer's
`next_cursor` as `cursor`; the body is `{ items, next_cursor, counts }`. Every other list is returned whole.

### Time format

- Portal and staff JSON: ISO-8601 datetimes in UTC; calendar dates as `YYYY-MM-DD`.
- Report, calendar, timesheet, screenshot-day and dashboard-day boundaries use the company's IANA
  `timezone` (default `UTC`, B19).
- CSV exports write times as ISO 8601 with the company `timezone` offset ([`data-export`][data-export]).
- Agents send and receive Unix milliseconds, UTC ([agent-contract.md](agent-contract.md)).

## Error code catalog

One catalog for all clients, owned by this repository (B9, `packages/shared`).

| Status | `code` | Clients | Meaning |
|---|---|---|---|
| 400 | `VALIDATION_FAILED` | all | Malformed body, query or path |
| 400 | `WEBHOOK_SIGNATURE_INVALID` | Stripe | `Stripe-Signature` missing or wrong |
| 401 | `UNAUTHENTICATED` | portal, staff, cron | Missing, malformed, expired or forged JWT; disabled or mismatched user; wrong `X-Cron-Secret` |
| 401 | `DEVICE_REVOKED` | agent | Unknown, replaced or deactivated device key |
| 401 | `DEVICE_RELEASED` | agent | Device released by its company; body carries `released_at` and `upload_until`. The upload routes still accept the key for 7 days (D45) |
| 402 | `COMPANY_SUSPENDED` | agent | Company suspended (device-key routes) |
| 402 | `LICENSE_SUSPENDED` | Downloader, agent | Company suspended (validate, enroll) |
| 402 | `LICENSE_EXPIRED` | Downloader, agent | Company expired; body carries `blocking_ends_at` |
| 202 | — (`{ data: { change } }`) | portal | An `it_admin` write on an approval route: stored as a pending change, not applied ([portal-api.md](portal-api.md#approvals)) |
| 403 | `PASSWORD_CHANGE_REQUIRED` | portal | Signed in with a temporary password; only `GET /v1/me`, `POST /v1/auth/password` and logout work until it is replaced |
| 403 | `FORBIDDEN` | portal, staff, uninstaller | Role not allowed on the route; device key deactivating another device |
| 404 | `PASSWORD_RESET_INVALID` | anyone | unknown reset token |
| 410 | `PASSWORD_RESET_EXPIRED` | anyone | reset token used or past 30 minutes |
| 403 | `SEAT_LIMIT_EXCEEDED` | Downloader, agent | No free seat |
| 403 | `ENROLLMENT_TOKEN_EXPIRED` | agent | Token older than 24 h |
| 403 | `ENROLLMENT_TOKEN_EXHAUSTED` | agent | Token already used |
| 404 | `NOT_FOUND` | portal, staff, agent | Unknown ID, another company's ID, an employee outside a manager's team; unknown screenshot `id` at confirm; unresolvable host |
| 404 | `LICENSE_NOT_FOUND` | Downloader | Unknown licence key, including one replaced by a reissue |
| 404 | `ENROLLMENT_TOKEN_INVALID` | agent | Unknown token, including unused tokens deleted by a reissue or by `/cron/token-expiry` |
| 404 | `EMPLOYEE_NOT_FOUND` | Downloader, agent, portal | Employee not active in the company (validate, enroll); employee out of reach on reports, calendar, timesheet |
| 404 | `INVITATION_INVALID` | portal | Invitation token matches nothing |
| 409 | `CONFLICT` | portal, staff | Duplicate or state conflict (see each route) |
| 409 | `DEVICE_ASSIGNED` | agent | Enroll: the device ID has a live binding for another employee; release it first (D48) |
| 409 | `EMPLOYEE_HAS_DEVICES` | portal | Employee still has a binding that is not released (deactivated ones count) |
| 409 | `IDEMPOTENCY_KEY_REUSED` | agent | Same idempotency key or ID, different content |
| 410 | `INVITATION_EXPIRED` | portal | Invitation accepted, revoked or past `expires_at` |
| 413 | `PAYLOAD_TOO_LARGE` | all | Body over the route's limit; CSV import over its limit |
| 422 | `VALIDATION_FAILED` | all | Well-formed but wrong |
| 422 | `EXPORT_TOO_LARGE` | portal | CSV export would exceed the row cap |
| 429 | `RATE_LIMITED` | all | Over the limit; `Retry-After` set |
| 500 | `INTERNAL` | all | Unexpected server error |
| 503 | `SERVICE_UNAVAILABLE` | ops | `GET /health` only: the database is unreachable |

`ENROLLMENT_TOKEN_REVOKED`, in the agents' own list, is never returned.

## Unspecified

Nothing is left open. Portal writes are never refused for billing while a company is `suspended`
or `expired` ([`company-status`][company-status]); only agent and Downloader routes answer `402`.

[api-envelope]: ../../openspec/changes/establish-api-foundation/specs/api-envelope/spec.md
[request-scope]: ../../openspec/changes/establish-api-foundation/specs/request-scope/spec.md
[rate-limiting]: ../../openspec/changes/establish-api-foundation/specs/rate-limiting/spec.md
[schema-migrations]: ../../openspec/changes/establish-api-foundation/specs/schema-migrations/spec.md
[user-authentication]: ../../openspec/changes/authenticate-users/specs/user-authentication/spec.md
[role-access]: ../../openspec/changes/authenticate-users/specs/role-access/spec.md
[staff-accounts]: ../../openspec/changes/authenticate-users/specs/staff-accounts/spec.md
[alerts-feed]: ../../openspec/changes/process-tamper-alerts/specs/alerts-feed/spec.md
[data-export]: ../../openspec/changes/report-usage/specs/data-export/spec.md
[cron-routes]: ../../openspec/changes/run-scheduled-jobs/specs/cron-routes/spec.md
[company-status]: ../../openspec/changes/provision-companies/specs/company-status/spec.md
