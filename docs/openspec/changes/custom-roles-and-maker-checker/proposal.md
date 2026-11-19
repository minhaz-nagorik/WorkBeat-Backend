## Why

The product owner decided on 19 Nov 2026 that: a company may start with two Company Admins; every
change by anyone else waits for a Company Admin; Company Admins check each other when there is more
than one; and Company Admin becomes the only fixed company role, the others being made by Company
Admins with the areas they choose.

## What Changes

- `POST /v1/staff/companies` takes an optional `admin_email_2` and invites both.
- Roles `manager` and `it_admin` are replaced by `member` plus a custom role (`roles` table,
  `/v1/roles`); existing IT Admins and Managers move to roles of those names with the same access.
- `GET /v1/me` and `GET /v1/team` carry `role_id`, `role_name`, `permissions`, `team_only`.
  Invitations and role changes take `{ role: 'company_admin' }` or `{ role: 'member', role_id }`.
- A member's write always becomes a pending change; a Company Admin's write does too while the
  company has another enabled Company Admin. Team, roles, company settings, minimum agent version
  and employee restore become approval routes. The maker never decides their own change, unless
  they are the only Company Admin left.
- `alert_email.roles` holds `company_admin` or role ids.
- Migration 0013.

## Capabilities

### New Capabilities

- `custom-roles`: roles, permissions, own-team scope.
- `maker-checker`: who waits for whom.

### Modified Capabilities

- `change-approvals` (approve-it-admin-changes) and `role-access` (authenticate-users): superseded
  where they name `it_admin` or `manager`.

## Impact

- Breaking for the web platform: roles, `/v1/me`, team and invitation bodies. The agents are not affected.
