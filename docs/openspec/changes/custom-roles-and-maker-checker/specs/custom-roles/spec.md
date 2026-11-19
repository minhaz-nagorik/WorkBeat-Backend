## Purpose

Company Admin is the only fixed company role. Company Admins make the other roles: a name, the
areas the role may see or change, and whether it sees only its own team.

## ADDED Requirements

### Requirement: Company Admins manage roles
<!-- source: product owner 19 Nov 2026 -->
`GET`, `POST /v1/roles`, `PATCH` and `DELETE /v1/roles/:id` SHALL be open to a `company_admin` only. A role SHALL have a `name` unique in the company ignoring case (1–60 characters), `permissions` from `reports`, `employees.view`, `employees.edit`, `devices.view`, `devices.edit`, `alerts.view`, `alerts.edit`, `policy.view`, `policy.edit`, `deployment`, and `team_only`. An edit permission MUST bring its view permission. A role with enabled users MUST NOT be deleted (`409`); deleting one cancels its open invitations.

#### Scenario: Same name twice
- **WHEN** a company admin creates `Auditor` and then `auditor`
- **THEN** the second call is `409 CONFLICT`

#### Scenario: Edit brings view
- **WHEN** a role is saved with `devices.edit` only
- **THEN** its `permissions` are `devices.edit` and `devices.view`

### Requirement: A member's access follows their role
<!-- source: product owner 19 Nov 2026 -->
Every company user other than a `company_admin` SHALL be a `member` with a `role_id` of their company. Each portal route MUST check one permission, Company Admin, or any company user, and answer `403 FORBIDDEN` otherwise. A `team_only` member MUST see only employees whose `manager_user_id` is theirs, and only such members may be an employee's manager.

#### Scenario: A role without reports
- **WHEN** a member whose role lacks `reports` asks for `GET /v1/reports/activity`
- **THEN** the response is `403 FORBIDDEN`

### Requirement: Existing IT Admins and Managers keep their access
<!-- source: product owner 19 Nov 2026 -->
Migration 0013 SHALL give each company with `it_admin` or `manager` users or open invitations a role `IT Admin` or `Manager` with the access those roles had, and move those users and invitations to it.

#### Scenario: A manager after the migration
- **WHEN** migration 0013 runs on a company with a manager
- **THEN** that user is a `member` of `Manager`, `team_only`, with `reports` and `employees.view`
