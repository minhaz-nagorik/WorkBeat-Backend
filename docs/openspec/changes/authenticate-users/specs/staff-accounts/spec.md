## Purpose

How WorkBeat staff accounts (`super_admin`) are created and removed, the MFA they must use, and
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

#### Scenario: Staff without MFA invite
- **WHEN** a `super_admin` at `aal1` calls `POST /v1/staff/invitations`
- **THEN** the response is `403` with `code` `MFA_REQUIRED` and no invitation is written

### Requirement: No route creates a super admin any other way
<!-- source: D41 · Plan-v3.5 §4.4, §4.6 -->
No sign-up route, Stripe event or company invitation SHALL create a `super_admin`. The first `super_admin` MUST be created only by an operator script run with the service credentials, outside the API.

#### Scenario: A sign-up names role super_admin
- **WHEN** any portal request tries to set `role` `super_admin` for a new or existing user
- **THEN** the response is `422 VALIDATION_FAILED` and no `super_admin` exists afterwards

### Requirement: Staff must use MFA on every call
<!-- source: D41 · Plan-v3.5 §4.6 · Plan-v3.5 §8 -->
Every request from a `super_admin` SHALL require a token whose `aal` claim is `aal2`. A `super_admin` token at `aal1` MUST get `403 MFA_REQUIRED` on every route except `GET /v1/me`.

#### Scenario: Staff without MFA
- **WHEN** a `super_admin` token with `aal` = `aal1` calls `GET /v1/staff/companies`
- **THEN** the response is `403` with `code` `MFA_REQUIRED`

#### Scenario: A new staff member before enrolling MFA
- **WHEN** a just-accepted `super_admin` at `aal1` calls `GET /v1/me`
- **THEN** the response is `200` with `role` `super_admin`

#### Scenario: No aal claim
- **WHEN** a `super_admin` token carries no `aal` claim
- **THEN** it is treated as `aal1` and `GET /v1/staff/companies` answers `403 MFA_REQUIRED`

#### Scenario: Company roles are not asked for MFA
- **WHEN** a `company_admin` token at `aal1` calls `GET /v1/team`
- **THEN** the response is `200`

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
- **WHEN** a disabled `super_admin` calls `GET /v1/staff/companies` with an unexpired `aal2` token
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
