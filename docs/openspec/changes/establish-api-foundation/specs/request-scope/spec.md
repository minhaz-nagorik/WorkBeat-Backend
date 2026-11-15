## Purpose

How every request is bound to exactly one tenant, the staff area, or a system job, before it
touches the database, so a missed filter returns nothing instead of another company's data.

## ADDED Requirements

### Requirement: Every request runs in one scoped transaction
<!-- source: B2 · Plan-v3.2 §6.1 -->
Every request that reads or writes the database SHALL run in one transaction that sets `app.scope` and, in `tenant` scope, `app.company_id`, before its first query. The API MUST connect as `workbeat_api`, which is subject to row-level security.

#### Scenario: A company user lists employees
- **WHEN** a company user's request reads `employees`
- **THEN** the transaction set `app.scope` = `tenant` and `app.company_id` to the user's company first
- **AND** only that company's rows are returned

### Requirement: The tenant comes from the credential, never the request
<!-- source: Plan-v3.2 §4.4 "Tenant guard", §6.1 -->
`app.company_id` SHALL come only from the user's token, the device key, the licence key or the host name. A `company_id` in a body, query or path MUST NOT select a company.

#### Scenario: A body names another company
- **WHEN** a company admin sends a body with another company's `company_id`
- **THEN** the field is ignored
- **AND** the write lands in the admin's own company or is refused

### Requirement: Staff requests run in staff scope
<!-- source: D41 · B2 · Plan-v3.2 §6.1 -->
A request authenticated as `super_admin` SHALL run with `app.scope` = `staff` and no `app.company_id`. In that scope only `companies`, `licenses`, `users`, `invitations` and the global tables MUST be readable.

#### Scenario: A staff request reads devices
- **WHEN** a staff-scope transaction queries `devices`
- **THEN** it receives no rows

### Requirement: A request without a scope sees nothing
<!-- source: B2 -->
A transaction that has not set `app.scope` SHALL read no tenant rows and write none. A route outside `/cron/*` MUST NOT set `system` scope.

#### Scenario: A route forgets to set the scope
- **WHEN** a query on `employees` runs before any scope is set
- **THEN** it returns no rows

### Requirement: Credentials are resolved through narrow lookups
<!-- source: B3 -->
Before a tenant is known, the API SHALL resolve a device key, licence key, enrollment token, invitation token or host name only through `auth_device`, `auth_license`, `auth_enrollment_token`, `auth_invitation` and `company_by_host`, and MUST compare only SHA-256 hashes of the presented secret.

#### Scenario: An agent presents its device key
- **WHEN** a request carries `X-Device-Key`
- **THEN** its SHA-256 is resolved through `auth_device`
- **AND** the transaction then runs in that device's company
