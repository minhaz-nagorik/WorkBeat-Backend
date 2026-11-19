## Purpose

Who waits for whom before a change takes effect.

## ADDED Requirements

### Requirement: A member's write always waits for a Company Admin
<!-- source: product owner 19 Nov 2026 -->
A `member`'s write on an approval route SHALL become a pending change answered `202 { change }`. A member's write on any other route except their own password, sign-out and cancelling their own change MUST get `403`. Any Company Admin MAY decide it alone.

#### Scenario: Three Company Admins and one member
- **WHEN** a member asks to release a computer
- **THEN** any one of the three Company Admins can approve it, with no second approval

### Requirement: Company Admins check each other
<!-- source: product owner 19 Nov 2026 -->
A `company_admin`'s write on an approval route SHALL become a pending change while the company has another enabled `company_admin`, and SHALL apply at once otherwise. Team invitations, role changes, user removal, roles, company settings, the minimum agent version and employee restore MUST be approval routes. The one who asked MUST NOT approve or reject their own change (`403`) unless no other enabled Company Admin remains.

#### Scenario: Two Company Admins
- **WHEN** admin A adds a block rule
- **THEN** the response is `202`, A's approve is `403`, and admin B's approve applies it

#### Scenario: The only Company Admin
- **WHEN** a company has one Company Admin and they add a block rule
- **THEN** the rule is created at once with `201`

### Requirement: A company may start with two Company Admins
<!-- source: product owner 19 Nov 2026 -->
`POST /v1/staff/companies` SHALL take an optional `admin_email_2`, different from `admin_email`, checked the same way, and invite both as Company Admins with the licence key in each email. The response MUST carry `invitations`.

#### Scenario: Same email twice
- **WHEN** staff create a company with `admin_email_2` equal to `admin_email`
- **THEN** the response is `422 VALIDATION_FAILED` naming `admin_email_2`
