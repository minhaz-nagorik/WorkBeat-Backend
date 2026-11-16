## Purpose

How a company user or a WorkBeat staff member proves who they are on every portal and staff
route, where their role and company come from, and what an unauthenticated call gets.

## ADDED Requirements

### Requirement: Portal and staff routes need a verified Supabase token
<!-- source: D41 · Plan-v3.5 §4.4 "Authentication and authorization" -->
Every route outside the agent, Downloader, webhook, cron, invitation, host-resolution (`GET /v1/hosts/resolve`) and health routes SHALL require `Authorization: Bearer <Supabase JWT>` whose signature, issuer and expiry the API verifies. A missing, malformed, expired or forged token MUST get `401 UNAUTHENTICATED` and the route MUST NOT run.

#### Scenario: No token
- **WHEN** `GET /v1/me` is called without `Authorization`
- **THEN** the response is `401` with `code` `UNAUTHENTICATED`

#### Scenario: Expired token
- **WHEN** a request carries a JWT past its `exp`
- **THEN** the response is `401 UNAUTHENTICATED`
- **AND** no query on a tenant table runs

#### Scenario: A token from another Supabase project
- **WHEN** a request carries a well-formed JWT signed by a key the API does not trust
- **THEN** the response is `401 UNAUTHENTICATED`

#### Scenario: An unsigned token
- **WHEN** a JWT has header `alg` `none`
- **THEN** the response is `401 UNAUTHENTICATED`

#### Scenario: A token at its expiry second
- **WHEN** a JWT's `exp` equals the server time
- **THEN** the response is `401 UNAUTHENTICATED`

### Requirement: Role and company come only from app_metadata
<!-- source: D41 · Plan-v3.5 §4.4, §6.1 -->
The API SHALL read the caller's `role` and `company_id` only from the token's `app_metadata`, which only the API writes. It MUST ignore `user_metadata` and any role or company in the request. A `super_admin` MUST have no `company_id`; every other role MUST have one.

#### Scenario: A user edits their own metadata
- **WHEN** a manager's token carries `user_metadata.role` = `company_admin`
- **THEN** the request is handled with role `manager`

#### Scenario: A company role without a company
- **WHEN** a token's `app_metadata` has role `it_admin` and no `company_id`
- **THEN** the response is `401 UNAUTHENTICATED`

#### Scenario: Staff with a company
- **WHEN** a token's `app_metadata` has role `super_admin` and a `company_id`
- **THEN** the response is `401 UNAUTHENTICATED`

#### Scenario: A company in the request body
- **WHEN** a company A admin sends a request body with `company_id` of company B
- **THEN** the request runs for company A only

### Requirement: The token must match an enabled users row
<!-- source: D41 · data-model.md "users" -->
The API SHALL load the `users` row with the token's subject. When no row exists, its `disabled_at` is set, or its `role` or `company_id` differs from `app_metadata`, the response MUST be `401 UNAUTHENTICATED`. A removed user MUST be refused on their next call, even with an unexpired token.

#### Scenario: A removed user calls again
- **WHEN** a company admin has removed a manager and the manager's unexpired token calls `GET /v1/me`
- **THEN** the response is `401 UNAUTHENTICATED`

#### Scenario: A demoted user's old token
- **WHEN** a company admin was changed to `manager` and their unexpired token still says `company_admin`
- **THEN** the response is `401 UNAUTHENTICATED` until they sign in again

#### Scenario: A disabled user with a valid JWT
- **WHEN** a user with `disabled_at` set calls any portal route with a token that passes signature and expiry checks
- **THEN** the response is `401 UNAUTHENTICATED` and no tenant table is read

#### Scenario: A user of a suspended company
- **WHEN** an enabled company admin of a `suspended` company calls `GET /v1/me`
- **THEN** the response is `200` with `company.status` `suspended`

### Requirement: The request scope follows the authenticated user
<!-- source: B2 · Plan-v3.5 §6.1 -->
A company user's request SHALL run in `tenant` scope with `app.company_id` from their `users` row. A `super_admin` request SHALL run in `staff` scope with no `app.company_id`.

#### Scenario: A company admin reads data
- **WHEN** a company admin of company A calls a portal route
- **THEN** the transaction runs with `app.scope` = `tenant` and `app.company_id` = A

### Requirement: The signed-in user can read who they are
<!-- source: Plan-v3.5 §4.5 · D41 -->
`GET /v1/me` SHALL return the caller's `id`, `email`, `name`, `role` and, for a company user, `company` with `id`, `name`, `slug` and `status`; for a `super_admin`, `company` MUST be `null`. All four roles SHALL be allowed.

#### Scenario: A staff member signs in
- **WHEN** a `super_admin` with MFA calls `GET /v1/me`
- **THEN** the response carries `role` `super_admin` and `company` `null`
