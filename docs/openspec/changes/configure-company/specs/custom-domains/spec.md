## Purpose

How a company opens its dashboard at its own domain: the admin sets it, proves it with a DNS TXT
record, the verification job activates it, and the API resolves a host name to its company.

## ADDED Requirements

### Requirement: A company admin sets a custom domain
<!-- source: PRD "Tenants and custom domains" · Plan-v3.2 §4.4 -->
`PUT /v1/company/custom-domain` with `domain` SHALL be allowed to `company_admin` only. It MUST set `custom_domain` (lower case), `custom_domain_status` `pending`, a new random `custom_domain_token`, and clear `custom_domain_verified_at`. A domain under `workbeat.io` or not a valid host name MUST get `422 VALIDATION_FAILED`; a domain another company holds MUST get `409 CONFLICT`.

#### Scenario: An admin adds a domain
- **WHEN** a company admin puts `{ "domain": "Monitor.Acme.com" }`
- **THEN** `custom_domain` is `monitor.acme.com` with `custom_domain_status` `pending`

#### Scenario: The domain is taken
- **WHEN** another company already holds `monitor.acme.com`
- **THEN** the response is `409` with `code` `CONFLICT`

#### Scenario: Another company's active domain
- **WHEN** a company admin puts a domain that is `active` for another company
- **THEN** the response is `409` with `code` `CONFLICT` and the other company's domain is unchanged

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
<!-- source: PRD "Tenants and custom domains" -->
`GET /v1/company/custom-domain` SHALL return, to `company_admin` only, `domain`, `status`, `cname_target` `proxy.workbeat.io`, `txt_name` `_workbeat.{domain}`, `txt_value` `verify-{token}`, `checked_at` and `verified_at`, or `data` `null` when none is set. `DELETE /v1/company/custom-domain` MUST clear every `custom_domain*` column.

#### Scenario: A pending domain
- **WHEN** a company admin reads a pending domain `monitor.acme.com`
- **THEN** the response carries `txt_name` `_workbeat.monitor.acme.com` and `txt_value` `verify-` followed by the token

### Requirement: The verification job activates a matching domain
<!-- source: Plan-v3.2 §6.4 · PRD "Tenants and custom domains" -->
`/cron/domain-verify`, run every 5 minutes, SHALL look up the TXT record `_workbeat.{domain}` of every `pending` domain and set `custom_domain_checked_at`. When a value equals `verify-{token}` it MUST set `custom_domain_status` `active` and `custom_domain_verified_at`. A domain still unmatched after the cut-off in `packages/shared` MUST become `failed`.

#### Scenario: The TXT record is found
- **WHEN** `_workbeat.monitor.acme.com` holds `verify-{token}` and the job runs
- **THEN** the domain's status is `active` and `custom_domain_verified_at` is set

#### Scenario: The record is not there yet
- **WHEN** the TXT record is missing and the cut-off has not passed
- **THEN** the domain stays `pending` and `custom_domain_checked_at` is updated

#### Scenario: Several TXT values
- **WHEN** `_workbeat.monitor.acme.com` holds three values, one of them `verify-{token}`
- **THEN** the domain becomes `active`

#### Scenario: A token from before a re-set
- **WHEN** the TXT record holds the token of a domain value the company replaced
- **THEN** the domain stays `pending`

#### Scenario: Verification flaps
- **WHEN** an `active` domain's TXT record is later removed or the lookup fails
- **THEN** the domain stays `active`, because only `pending` domains are checked

### Requirement: A failed DNS lookup changes nothing
<!-- source: Plan-v3.2 §6.4 -->
A TXT lookup that times out or errors SHALL leave the domain's status unchanged, and one domain's failure MUST NOT stop the job checking the others.

#### Scenario: DNS times out
- **WHEN** the lookup for one domain times out
- **THEN** that domain stays `pending` and the next domain is still checked

#### Scenario: Every lookup fails
- **WHEN** the resolver is down for a whole run
- **THEN** every domain keeps its status and the run still answers `200`

### Requirement: A host name resolves to its company
<!-- source: PRD "Tenants and custom domains" · B3 · Plan-v3.2 §6.1 -->
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

### Requirement: A failed domain is released
<!-- source: PRD "Tenants and custom domains" · Plan-v3.2 §6.4 -->
`/cron/domain-verify` SHALL clear every `custom_domain*` column of a domain that has been `failed` for longer than the release period in `packages/shared`, so a domain a company never proved is free for the company that owns it. A `failed` domain MUST stay visible to its admin until then.

#### Scenario: A squatted domain
- **WHEN** company B set `monitor.acme.com`, it failed, and the release period passed
- **THEN** company B's `custom_domain` is NULL and company A can set `monitor.acme.com`

#### Scenario: Within the release period
- **WHEN** a domain failed yesterday
- **THEN** `GET /v1/company/custom-domain` still shows it with `status` `failed`
