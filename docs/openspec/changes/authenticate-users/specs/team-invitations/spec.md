## Purpose

How a company admin brings colleagues into the company's portal with a role, how an invitation
is accepted, and how a company admin changes a role or removes a user.

## ADDED Requirements

### Requirement: A company admin invites a colleague
<!-- source: Plan-v3.2 §4.4 "User invitations", §4.5 "Settings" · PRD "Users and roles" -->
`POST /v1/team/invitations` with `email` and `role` (`company_admin`, `manager` or `it_admin`) SHALL be allowed to `company_admin` only. It MUST insert an `invitations` row with the caller's company, `invited_by` = the caller, a random token stored only as `token_hash` and `expires_at` from `packages/shared`, then email the token link through Resend.

#### Scenario: An admin invites an IT admin
- **WHEN** a company admin posts `{ "email": "it@acme.com", "role": "it_admin" }`
- **THEN** the response is `201` with the invitation `id`, `email`, `role` and `expires_at`, never the token
- **AND** one email with the acceptance link is sent to `it@acme.com`

#### Scenario: Role super_admin is refused
- **WHEN** a company admin invites with role `super_admin`
- **THEN** the response is `422 VALIDATION_FAILED` and no row is written

### Requirement: One open invitation and one account per email
<!-- source: data-model.md "invitations" · D41 -->
An invitation for an email that already has an open invitation in the company, or that already belongs to any `users` row, SHALL answer `409 CONFLICT` and MUST write nothing.

#### Scenario: The same person is invited twice
- **WHEN** an open invitation for `it@acme.com` exists and the admin invites it again
- **THEN** the response is `409` with `code` `CONFLICT`

#### Scenario: The email is a user of another company
- **WHEN** a company admin invites `pat@example.com`, who is a `manager` of another company
- **THEN** the response is `409` with `code` `CONFLICT` and nothing about the other company is revealed

#### Scenario: The email differs only in case
- **WHEN** an open invitation for `it@acme.com` exists and the admin invites `IT@Acme.com`
- **THEN** the response is `409` with `code` `CONFLICT`

#### Scenario: The email belongs to a disabled user of the company
- **WHEN** a company admin invites the email of a removed user of the same company
- **THEN** the response is `409` with `code` `CONFLICT`

#### Scenario: Two admins invite the same email at once
- **WHEN** two invitations for one email in one company are handled concurrently
- **THEN** one gets `201` and the other `409 CONFLICT`, and one email is sent

### Requirement: The team list shows users and open invitations
<!-- source: Plan-v3.2 §4.5 "Settings" -->
`GET /v1/team` SHALL return, for `company_admin` only, the company's `users` (`id`, `name`, `email`, `role`, `created_at`) without disabled ones, and its open invitations (`id`, `email`, `role`, `created_at`, `expires_at`). `POST /v1/team/invitations/:id/resend` MUST replace `token_hash`, renew `expires_at` and send a new email; `DELETE /v1/team/invitations/:id` MUST set `revoked_at`.

#### Scenario: An admin cancels an invitation
- **WHEN** a company admin deletes an open invitation
- **THEN** `revoked_at` is set and the response is `204`
- **AND** its token then answers `410 INVITATION_EXPIRED`

#### Scenario: An invitation is resent
- **WHEN** a company admin resends an invitation
- **THEN** the old link stops working and a new link is emailed

#### Scenario: The old link after a resend
- **WHEN** an invitation is resent and the first link is opened
- **THEN** `POST /v1/invitations/lookup` with the first token answers `404 INVITATION_INVALID`

#### Scenario: An expired invitation is resent
- **WHEN** a company admin resends an invitation past `expires_at` that was neither accepted nor revoked
- **THEN** it gets a new `token_hash` and `expires_at` and a new email is sent

### Requirement: An invitation is accepted once
<!-- source: B3 · D41 · Plan-v3.2 §4.4 -->
`POST /v1/invitations/lookup` with `token` SHALL return `email`, `role` and the company `name`. `POST /v1/invitations/accept` with `token`, `name` and `password` SHALL create the Supabase Auth user with `app_metadata` `{ role, company_id }`, insert the `users` row and set `accepted_at`, in one transaction. Both resolve the token only through `auth_invitation`.

#### Scenario: A manager accepts
- **WHEN** a valid manager invitation is accepted
- **THEN** a `users` row with role `manager` and the invitation's `company_id` exists
- **AND** the invitation has `accepted_at` set and the response is `201`

#### Scenario: An unknown token
- **WHEN** a token matches no invitation
- **THEN** the response is `404` with `code` `INVITATION_INVALID`

#### Scenario: A used or expired token
- **WHEN** a token's invitation is accepted, revoked or past `expires_at`
- **THEN** the response is `410` with `code` `INVITATION_EXPIRED` and no user is created

#### Scenario: Accepted twice at the same moment
- **WHEN** two `POST /v1/invitations/accept` with one token are handled concurrently
- **THEN** one gets `201` and the other `410 INVITATION_EXPIRED`
- **AND** exactly one Supabase Auth user and one `users` row exist

#### Scenario: Accepted at the expiry instant
- **WHEN** a token is presented when the server time equals `expires_at`
- **THEN** the response is `410` with `code` `INVITATION_EXPIRED`

#### Scenario: The email became a user meanwhile
- **WHEN** an invitation is accepted after its email became a `users` row elsewhere, for example as a buyer
- **THEN** the response is `409` with `code` `CONFLICT` and the invitation stays open

#### Scenario: The inviter was removed
- **WHEN** the admin who sent an open invitation is disabled before it is accepted
- **THEN** the invitation is still accepted

#### Scenario: A suspended company
- **WHEN** an invitation of a `suspended` company is accepted
- **THEN** the user is created and can read the company's status

### Requirement: A company admin changes roles and removes users
<!-- source: Plan-v3.2 §4.5 "Settings" · PRD "Permission matrix" -->
`PATCH /v1/team/users/:id` with `role` and `DELETE /v1/team/users/:id` SHALL be allowed to `company_admin` only, update `app_metadata` with the `users` row, and on removal set `disabled_at` and end the user's sessions. A change that would leave the company with no enabled `company_admin` MUST answer `409 CONFLICT`. A user who stops being a manager MUST have their employees' `manager_user_id` set to NULL.

#### Scenario: The last admin removes themselves
- **WHEN** the only company admin deletes their own user
- **THEN** the response is `409 CONFLICT` and nothing changes

#### Scenario: A manager is removed
- **WHEN** a company admin removes a manager
- **THEN** the manager's `disabled_at` is set and their next call gets `401 UNAUTHENTICATED`
- **AND** employees that had them as `manager_user_id` have none

#### Scenario: The last admin demotes themselves
- **WHEN** the only enabled company admin patches their own `role` to `manager`
- **THEN** the response is `409` with `code` `CONFLICT` and the role is unchanged

#### Scenario: Two admins demote each other at once
- **WHEN** the company's only two company admins each demote the other concurrently
- **THEN** one change succeeds and the other answers `409 CONFLICT`, leaving one enabled company admin

#### Scenario: A manager becomes an IT admin
- **WHEN** a company admin changes a manager's role to `it_admin`
- **THEN** employees that had them as `manager_user_id` have none

#### Scenario: A user of another company
- **WHEN** a company A admin patches a user ID of company B
- **THEN** the response is `404 NOT_FOUND`

#### Scenario: Role super_admin
- **WHEN** a company admin patches a user's `role` to `super_admin`
- **THEN** the response is `422 VALIDATION_FAILED`

### Requirement: Only open invitations are resent or revoked
<!-- source: Plan-v3.2 §4.4 "User invitations" · data-model.md "invitations" -->
Resending an accepted or revoked invitation SHALL answer `409 CONFLICT` and change nothing. Revoking an already revoked invitation MUST return `204` and keep the first `revoked_at`; revoking an accepted one MUST answer `409 CONFLICT`. An acceptance and a revocation of one invitation MUST be serialised so only one of them takes effect.

#### Scenario: Resend after acceptance
- **WHEN** a company admin resends an invitation that was accepted
- **THEN** the response is `409` with `code` `CONFLICT` and no email is sent

#### Scenario: Revoked while being accepted
- **WHEN** an admin revokes an invitation while it is being accepted
- **THEN** either the user exists and the revocation answers `409 CONFLICT`, or the acceptance answers `410 INVITATION_EXPIRED` and no user exists

### Requirement: A failed acceptance leaves no account
<!-- source: B3 · D41 · Plan-v3.2 §4.4 -->
When the Supabase Auth user is created but the `users` row or `accepted_at` cannot be written, the API SHALL delete that Auth user before answering `500 INTERNAL`, and the invitation MUST stay open so the same link can be used again. A password the Auth service refuses MUST answer `422 VALIDATION_FAILED` and create nothing.

#### Scenario: The database write fails after the Auth user exists
- **WHEN** inserting the `users` row fails after the Auth user was created
- **THEN** no Auth user remains for the email and the invitation is still open

#### Scenario: A weak password
- **WHEN** the password is refused by the Auth password policy
- **THEN** the response is `422 VALIDATION_FAILED` and the invitation is still open
