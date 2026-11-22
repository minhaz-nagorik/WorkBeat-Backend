## Purpose

How a company opens its dashboard at its own domain: its company admin sets the domain (B33), WorkBeat
staff check the DNS TXT record by hand and approve it, and the API resolves a host name to its company.

## ADDED Requirements

### Requirement: Setting a custom domain
<!-- source: B33 · PRD "Tenants and custom domains" · Plan-v3.5 §4.4 -->
`PUT /v1/company/custom-domain` with `domain` SHALL be allowed to `company_admin` only; every other company role and staff MUST get `403 FORBIDDEN`. It MUST set `custom_domain` (lower case, no trailing dot), `custom_domain_status` `pending`, a new random `custom_domain_token`, and clear `custom_domain_checked_at` and `custom_domain_verified_at`.

#### Scenario: An admin adds a domain
- **WHEN** a company admin puts `{ "domain": "Monitor.Acme.com" }`
- **THEN** `custom_domain` is `monitor.acme.com` with `custom_domain_status` `pending`

#### Scenario: Another role adds a domain
- **WHEN** a member with a custom role puts a domain
- **THEN** the response is `403` with `code` `FORBIDDEN` and `custom_domain` is unchanged

#### Scenario: An active domain is replaced
- **WHEN** a company admin puts a new domain while the current one is `active`
- **THEN** the new domain is `pending` and the old domain no longer resolves

### Requirement: Domains that cannot be set
<!-- source: B33 · PRD "Tenants and custom domains" -->
A domain under `workbeat.io` or not a valid host name SHALL get `422 VALIDATION_FAILED`; a domain another company holds, in any status, MUST get `409 CONFLICT` and leave that company's domain unchanged. Putting the company's own current domain again MUST change nothing.

#### Scenario: The domain is taken
- **WHEN** another company already holds `monitor.acme.com`
- **THEN** the response is `409` with `code` `CONFLICT`

#### Scenario: Two companies claim one domain at once
- **WHEN** two companies put `monitor.acme.com` concurrently
- **THEN** one gets `pending` and the other `409 CONFLICT`

#### Scenario: The company's own current domain again
- **WHEN** a company admin puts the domain the company already holds
- **THEN** its status, token and `custom_domain_verified_at` are unchanged

#### Scenario: A trailing dot or the platform domain
- **WHEN** a company admin puts `monitor.acme.com.` or `WORKBEAT.IO`
- **THEN** the first is stored as `monitor.acme.com` and the second gets `422 VALIDATION_FAILED`

### Requirement: The admin sees the records to create
<!-- source: B33 · PRD "Tenants and custom domains" -->
`GET /v1/company/custom-domain` SHALL return, to `company_admin` only, `domain`, `status`, `cname_target` `proxy.workbeat.io`, `txt_name` `_workbeat.{domain}`, `txt_value` `verify-{token}`, `checked_at` and `verified_at`, or `data` `null` when none is set.

#### Scenario: A pending domain
- **WHEN** a company admin reads a pending domain `monitor.acme.com`
- **THEN** the response carries `txt_name` `_workbeat.monitor.acme.com` and `txt_value` `verify-` followed by the token

### Requirement: Removing a custom domain
<!-- source: B33 -->
`DELETE /v1/company/custom-domain` SHALL be allowed to `company_admin` only and MUST clear every `custom_domain*` column, answering `204`. Other roles MUST get `403 FORBIDDEN`.

#### Scenario: An admin removes an active domain
- **WHEN** a company admin deletes the custom domain
- **THEN** the response is `204`, `GET` returns `data` `null` and the domain no longer resolves

### Requirement: Staff read the records of a company's domain
<!-- source: B33 -->
`GET /v1/staff/companies/:id/custom-domain` SHALL return, to `super_admin` only, the same object as `GET /v1/company/custom-domain` for that company, or `data` `null`. An unknown company MUST get `404 NOT_FOUND`; any company role MUST get `403 FORBIDDEN`.

#### Scenario: Staff open a pending domain
- **WHEN** a super admin reads the custom domain of a company whose domain is pending
- **THEN** the response carries the `txt_name` and `txt_value` the company was shown

### Requirement: Staff approve or reject a domain
<!-- source: B33 -->
`PATCH /v1/staff/companies/:id/custom-domain` with `domain` and `status` (`active` or `failed`) SHALL be allowed to `super_admin` only. It MUST set `custom_domain_status` and `custom_domain_checked_at` to now; `active` MUST set `custom_domain_verified_at`, `failed` MUST clear it. No job or other route MUST make a domain `active`.

#### Scenario: Staff approve
- **WHEN** a super admin patches `{ "domain": "monitor.acme.com", "status": "active" }` for Acme
- **THEN** the domain is `active`, `custom_domain_verified_at` is set and it resolves to Acme

#### Scenario: Staff deactivate an active domain
- **WHEN** a super admin patches `status` `failed` for an `active` domain
- **THEN** the domain is `failed` and no longer resolves

#### Scenario: A company role approves
- **WHEN** a company admin calls the route
- **THEN** the response is `403` with `code` `FORBIDDEN`

### Requirement: Staff never approve a replaced domain
<!-- source: B33 -->
`PATCH /v1/staff/companies/:id/custom-domain` SHALL change the domain only when `domain` equals the company's current `custom_domain`; otherwise, or when no domain is set, it MUST answer `409 CONFLICT` and change nothing. Invalid `status` or a missing field MUST get `422 VALIDATION_FAILED`.

#### Scenario: The admin changed the domain during the review
- **WHEN** staff approve `old.acme.com` after the admin replaced it with `monitor.acme.com`
- **THEN** the response is `409` with `code` `CONFLICT` and `monitor.acme.com` stays `pending`

### Requirement: A host name resolves to its company
<!-- source: PRD "Tenants and custom domains" · B3 · Plan-v3.5 §6.1 -->
`GET /v1/hosts/resolve` with `host` SHALL need no credential and return the company `name` and `slug` for `{slug}.workbeat.io` or an `active` custom domain, resolved only through `company_by_host`. A `pending` or `failed` domain, or an unknown host, MUST get `404 NOT_FOUND`. A resolved host MUST NOT select the company of an authenticated request; the token does.

#### Scenario: An active custom domain
- **WHEN** the sign-in page on `monitor.acme.com` calls `GET /v1/hosts/resolve?host=monitor.acme.com`
- **THEN** the response carries Acme's `name` and `slug`

#### Scenario: A pending custom domain
- **WHEN** the host is a domain whose status is `pending`
- **THEN** the response is `404 NOT_FOUND`

#### Scenario: A deeper sub-domain of workbeat.io
- **WHEN** the host is `x.acme-ltd.workbeat.io`
- **THEN** the response is `404 NOT_FOUND`

#### Scenario: A suspended company's host
- **WHEN** the host is the slug host of a `suspended` company
- **THEN** the company still resolves so its users can sign in

#### Scenario: Upper case host
- **WHEN** the host is `Monitor.ACME.com` for an active `monitor.acme.com`
- **THEN** it resolves to that company
