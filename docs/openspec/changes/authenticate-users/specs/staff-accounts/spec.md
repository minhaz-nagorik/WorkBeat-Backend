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


### Requirement: No route creates a super admin any other way
<!-- source: D41 · Plan-v3.5 §4.4, §4.6 -->
No sign-up route, Stripe event or company invitation SHALL create a `super_admin`. The first `super_admin` MUST be created only by an operator script run with the database owner's credentials, outside the API (`pnpm seed -- --staff-email`).

#### Scenario: A sign-up names role super_admin
- **WHEN** any portal request tries to set `role` `super_admin` for a new or existing user
- **THEN** the response is `422 VALIDATION_FAILED` and no `super_admin` exists afterwards

### Requirement: A staff session exists only after a second factor
<!-- source: D41 · B23 · Plan-v3.5 §4.6 -->
A `super_admin` SHALL get a session only from `POST /v1/auth/mfa/verify` with the `mfa_token` from login and a valid TOTP code, so every staff session has passed MFA. Company roles MUST NOT be asked for a second factor. `MFA_REQUIRED` is therefore never returned.

#### Scenario: Staff stop after the password
- **WHEN** a `super_admin` signs in with the right password and calls `GET /v1/me` with the `mfa_token`
- **THEN** the response is `401 UNAUTHENTICATED`

#### Scenario: Company roles are not asked for MFA
- **WHEN** a `company_admin` signs in with the right password
- **THEN** the login response carries a session and `mfa_required` false

### Requirement: Staff set up an authenticator app at first sign-in
<!-- source: D41 · B23 -->
For a `super_admin` with no factor, `POST /v1/auth/mfa/enroll` with `mfa_token` SHALL return a new base32 `secret` and its `otpauth_uri` and keep the secret, encrypted, on the challenge. The first valid code at `POST /v1/auth/mfa/verify` MUST store it on the user and issue the session. Enrolling while a factor exists MUST answer `409 CONFLICT`.

#### Scenario: First sign-in of a new staff member
- **WHEN** staff enroll and send the code their app shows
- **THEN** the response carries a session and later sign-ins ask for a code from the same app

#### Scenario: Verify before enrolling
- **WHEN** a `super_admin` with no factor calls verify without enrolling first
- **THEN** the response is `409 CONFLICT` and no attempt is counted

### Requirement: MFA codes are checked once, with limited attempts
<!-- source: B23 · B25 -->
A code SHALL be a 6-digit TOTP (RFC 6238, SHA-1, 30 s) accepted for the previous, current or next step, and a step already used by that user MUST be refused. A wrong code MUST answer `401 MFA_CODE_INVALID` with `attempts_left`; after 5 wrong codes, or 10 minutes, the `mfa_token` MUST answer `401 UNAUTHENTICATED`.

#### Scenario: A wrong code
- **WHEN** staff send a wrong code for a new `mfa_token`
- **THEN** the response is `401 MFA_CODE_INVALID` with `attempts_left` 4

#### Scenario: A code used twice
- **WHEN** staff sign in again within the same 30 seconds and send the code they just used
- **THEN** the response is `401 MFA_CODE_INVALID`

#### Scenario: Too many wrong codes
- **WHEN** a sixth code is sent for an `mfa_token` after five wrong ones
- **THEN** the response is `401 UNAUTHENTICATED` and staff sign in with their password again

### Requirement: Another super admin resets a lost factor
<!-- source: D41 · B23 -->
`POST /v1/staff/users/:id/mfa/reset` SHALL be allowed to a `super_admin` for another enabled `super_admin`, clear their factor and revoke their sessions and MFA challenges, so they enroll again at their next sign-in. Resetting oneself MUST answer `409 CONFLICT`; a company user's ID MUST answer `404 NOT_FOUND`; a company role MUST get `403 FORBIDDEN`.

#### Scenario: A lost phone
- **WHEN** one `super_admin` resets another's factor
- **THEN** the other's sessions answer `401` and their next login returns `mfa_enrolled` false

#### Scenario: Resetting oneself
- **WHEN** a `super_admin` resets their own factor
- **THEN** the response is `409 CONFLICT` and the factor stays

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
