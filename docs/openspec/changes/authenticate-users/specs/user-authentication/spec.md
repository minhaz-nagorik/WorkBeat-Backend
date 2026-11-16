## Purpose

How a company user or a WorkBeat staff member proves who they are on every portal and staff
route: signing in with a password, the session token that follows, what ends it, and what an
unauthenticated call gets.

## ADDED Requirements

### Requirement: Users sign in with email and password
<!-- source: D41 · B22 · B25 · product owner 16 Nov 2026 -->
`POST /v1/auth/login` with `email` and `password` SHALL compare the password with the scrypt hash of the enabled `users` row of that email. Every user, company or staff, MUST get `200` with `token`, `expires_at` and `user` as `GET /v1/me` returns it. A wrong password, an unknown or disabled email MUST all get the same `401 UNAUTHENTICATED`.

#### Scenario: A company admin signs in
- **WHEN** a company admin sends the right email and password
- **THEN** the response is `200` with a `token` starting `wbs_` and `expires_at` 7 days later

#### Scenario: A wrong password and an unknown email
- **WHEN** one request sends a wrong password and another an email with no account
- **THEN** both answer `401 UNAUTHENTICATED` with the same body

#### Scenario: A removed user signs in
- **WHEN** a user with `disabled_at` set sends their right password
- **THEN** the response is `401 UNAUTHENTICATED`

### Requirement: A super admin signs in with a password only
<!-- source: D41 · B22 · product owner 16 Nov 2026 -->
For a `super_admin`, `POST /v1/auth/login` with the right password SHALL answer `200` with `token`, `expires_at` and `user`, exactly as for a company user. No role MUST be asked for a second factor.

#### Scenario: Staff sign in
- **WHEN** a `super_admin` sends the right email and password
- **THEN** the response is `200` with a `token` starting `wbs_`
- **AND** `GET /v1/me` with that token shows `role` `super_admin` and `company` `null`

### Requirement: Portal and staff routes need a live session
<!-- source: D41 · B22 -->
Every route outside the agent, Downloader, webhook, cron, sign-in, password-reset, invitation, host-resolution and health routes SHALL require `Authorization: Bearer <token>` whose SHA-256 matches a `sessions` row that is not revoked, not expired and belongs to an enabled user. Anything else MUST get `401 UNAUTHENTICATED` and the route MUST NOT run.

#### Scenario: No token
- **WHEN** `GET /v1/me` is called without `Authorization`
- **THEN** the response is `401` with `code` `UNAUTHENTICATED`

#### Scenario: An expired session
- **WHEN** a request carries a token whose `expires_at` has passed
- **THEN** the response is `401 UNAUTHENTICATED` and no tenant table is read

#### Scenario: A made-up token
- **WHEN** a request carries a `wbs_` token that matches no session
- **THEN** the response is `401 UNAUTHENTICATED`

### Requirement: Sessions end on logout, password change and removal
<!-- source: B22 · B24 · D41 -->
A session SHALL last 7 days. `POST /v1/auth/logout` MUST revoke the caller's session and answer `204`. `POST /v1/auth/password` with `current_password` and `new_password` (10–200 characters) MUST revoke the user's other sessions; a wrong current password MUST answer `422 VALIDATION_FAILED`. Removing a user MUST revoke all of their sessions.

#### Scenario: Sign out
- **WHEN** a user calls `POST /v1/auth/logout` and then `GET /v1/me` with the same token
- **THEN** the first answers `204` and the second `401 UNAUTHENTICATED`

#### Scenario: A password change signs out other devices
- **WHEN** a user changes their password from one browser
- **THEN** that browser's session keeps working and every other session of theirs answers `401`

#### Scenario: A removed user calls again
- **WHEN** a company admin has removed a manager and the manager's unexpired session calls `GET /v1/me`
- **THEN** the response is `401 UNAUTHENTICATED`

### Requirement: A forgotten password is reset by email
<!-- source: B24 -->
`POST /v1/auth/password-reset/request` with `email` SHALL always answer `204`, and for an enabled user MUST email a link with a single-use token valid 30 minutes. `POST /v1/auth/password-reset/confirm` with `token` and `new_password` MUST set the password, use up every open reset of the user, and revoke all their sessions. It MUST answer `404 PASSWORD_RESET_INVALID` or `410 PASSWORD_RESET_EXPIRED`.

#### Scenario: An unknown email
- **WHEN** a reset is requested for an email with no account
- **THEN** the response is `204` and no email is sent

#### Scenario: The link is used
- **WHEN** a user confirms with the emailed token and a new password
- **THEN** the response is `200`, their old sessions answer `401` and they can sign in with the new password

#### Scenario: The link is used twice
- **WHEN** the same token is confirmed a second time
- **THEN** the response is `410 PASSWORD_RESET_EXPIRED` and the password is unchanged

### Requirement: Sign-in routes are rate-limited per IP, never locked
<!-- source: B25 · rate-limiting -->
`/v1/auth/*`, `/v1/invitations/*` and `/v1/license/validate` SHALL each allow 20 requests a minute per client IP and answer `429 RATE_LIMITED` with `Retry-After` beyond it. No number of wrong passwords MUST lock an account. The client IP MUST come from `X-Forwarded-For` only when the connection is from a proxy on the API host.

#### Scenario: Guessing passwords
- **WHEN** one IP sends a 21st login request within a minute
- **THEN** it gets `429 RATE_LIMITED` with `Retry-After`, and the account still signs in from another IP

#### Scenario: A faked forwarding header
- **WHEN** a client sends each request with a different `X-Forwarded-For` through the tunnel
- **THEN** the limit still counts them as one IP

### Requirement: The request scope follows the authenticated user
<!-- source: B2 · Plan-v3.5 §6.1 -->
A company user's request SHALL run in `tenant` scope with `app.company_id` from their `users` row. A `super_admin` request SHALL run in `staff` scope with no `app.company_id`. A company role without a `company_id`, or a `super_admin` with one, MUST get `401 UNAUTHENTICATED`.

#### Scenario: A company admin reads data
- **WHEN** a company admin of company A calls a portal route
- **THEN** the transaction runs with `app.scope` = `tenant` and `app.company_id` = A

#### Scenario: A company in the request body
- **WHEN** a company A admin sends a request body with `company_id` of company B
- **THEN** the request runs for company A only

### Requirement: The signed-in user can read who they are
<!-- source: Plan-v3.5 §4.5 · D41 · B19 -->
`GET /v1/me` SHALL return the caller's `id`, `email`, `name`, `role` and, for a company user, `company` with `id`, `name`, `slug`, `status` and `timezone`; for a `super_admin`, `company` MUST be `null`. All four roles SHALL be allowed.

#### Scenario: A staff member signs in
- **WHEN** a `super_admin` signed in with their password calls `GET /v1/me`
- **THEN** the response carries `role` `super_admin` and `company` `null`

#### Scenario: A manager needs the company day
- **WHEN** a manager calls `GET /v1/me`
- **THEN** `company.timezone` carries the company's IANA zone

#### Scenario: A user of a suspended company
- **WHEN** an enabled company admin of a `suspended` company calls `GET /v1/me`
- **THEN** the response is `200` with `company.status` `suspended`
