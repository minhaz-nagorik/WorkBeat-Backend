## Purpose

How WorkBeat staff accounts (`super_admin`) are created and removed, and
the account routes that never exist for them: self sign-up and impersonation.

## ADDED Requirements

### Requirement: Only a super admin invites a super admin
<!-- source: D41 · Plan-v3.5 §4.4 "Staff accounts" -->
`POST /v1/staff/invitations` with `email` SHALL be allowed to `super_admin` only and MUST insert an `invitations` row with `company_id` NULL, `role` `super_admin` and `invited_by` = the caller, then email the link. Acceptance SHALL use `POST /v1/invitations/accept` and MUST create a `users` row with no `company_id`.

#### Scenario: Staff invite a colleague
- **WHEN** a `super_admin` invites `ops2@workbeat.io`
- **THEN** an invitation with `company_id` NULL and role `super_admin` is stored and emailed

#### Scenario: A company admin tries to invite staff
- **WHEN** a `company_admin` calls `POST /v1/staff/invitations`
- **THEN** the response is `403 FORBIDDEN`

#### Scenario: The email is a company user
- **WHEN** a `super_admin` invites an email that belongs to a company user
- **THEN** the response is `409` with `code` `CONFLICT`


### Requirement: No route creates a super admin any other way
<!-- source: D41 · Plan-v3.5 §4.4, §4.6 -->
No sign-up route, Stripe event or company invitation SHALL create a `super_admin`. The first `super_admin` MUST be created only by an operator script run with the database owner's credentials, outside the API (`pnpm seed -- --staff-email`).

#### Scenario: A sign-up names role super_admin
- **WHEN** any portal request tries to set `role` `super_admin` for a new or existing user
- **THEN** the response is `422 VALIDATION_FAILED` and no `super_admin` exists afterwards

### Requirement: Staff manage the staff team
<!-- source: D41 · Plan-v3.5 §4.6 -->
`GET /v1/staff/team` SHALL return only `users` with role `super_admin` and open staff invitations. `DELETE /v1/staff/invitations/:id` MUST set `revoked_at`; `DELETE /v1/staff/users/:id` MUST set `disabled_at` and end the sessions, and MUST answer `409 CONFLICT` for the caller themselves or the last enabled `super_admin`.

#### Scenario: Staff list the staff team
- **WHEN** a `super_admin` calls `GET /v1/staff/team`
- **THEN** no company user appears in the response

#### Scenario: Staff disable themselves
- **WHEN** a `super_admin` calls `DELETE /v1/staff/users/:id` with their own ID
- **THEN** the response is `409` with `code` `CONFLICT`

#### Scenario: The last two staff disable each other at once
- **WHEN** the only two enabled `super_admin` users disable each other concurrently
- **THEN** one change succeeds and the other answers `409 CONFLICT`

#### Scenario: A disabled staff member's valid JWT
- **WHEN** a disabled `super_admin` calls `GET /v1/staff/companies` with an unexpired session
- **THEN** the response is `401 UNAUTHENTICATED`

#### Scenario: A company user ID on the staff route
- **WHEN** a `super_admin` calls `DELETE /v1/staff/users/:id` with a company user's ID
- **THEN** the response is `404 NOT_FOUND` and the user is unchanged

### Requirement: There is no impersonation
<!-- source: D41 · PRD "Permission matrix" -->
No route SHALL issue a token, session or link that acts as another user, and no request MUST be able to switch its role or company after authentication.

#### Scenario: Staff ask to open a company dashboard
- **WHEN** a `super_admin` calls any company route with a company ID
- **THEN** the response is `403 FORBIDDEN`

### Requirement: A staff invitation is accepted without a session
<!-- source: D41 · product owner 16 Nov 2026 -->
`POST /v1/invitations/accept` for a `super_admin` invitation SHALL create the `users` row with no `company_id` and answer `201` with `user` only, no `token`: the person then signs in with their password (`POST /v1/auth/login`).

#### Scenario: A new staff member accepts
- **WHEN** a staff invitation is accepted with a name and password
- **THEN** the response is `201` with `user.role` `super_admin` and no `token`

### Requirement: Staff invitations follow the company rules
<!-- source: D41 · team-invitations -->
`POST /v1/staff/invitations` SHALL answer `409 CONFLICT` for an email with an open staff invitation or any `users` row. `POST /v1/staff/invitations/:id/resend` MUST replace the token, renew `expires_at` and email again, with the codes of the company team's resend: `404` unknown, `409` not open.

#### Scenario: Inviting the same email twice
- **WHEN** staff invite an email that already has an open staff invitation
- **THEN** the response is `409 CONFLICT` and one invitation exists

#### Scenario: Resending a staff invitation
- **WHEN** staff resend an open invitation
- **THEN** the old link answers `404 INVITATION_INVALID` and the new one works

### Requirement: Staff reissue a Company Admin's password as temporary
<!-- source: product owner 17 Nov 2026 -->
`POST /v1/staff/users/:id/temporary-password` SHALL be allowed to `super_admin` only, for an enabled `company_admin`; any other ID MUST get `404 NOT_FOUND`. It MUST set a generated password of at least 12 readable characters, `must_change_password` and `password_expires_at` 72 hours ahead, end the user's sessions and open password resets, answer `200 { temporary_password, expires_at }` with `Cache-Control: no-store`, and email the password to the user.

#### Scenario: A staff member is the target
- **WHEN** a super admin calls it with the ID of a `super_admin`
- **THEN** the response is `404 NOT_FOUND` and the password is unchanged
