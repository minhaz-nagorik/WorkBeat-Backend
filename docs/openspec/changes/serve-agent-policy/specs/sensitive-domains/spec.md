## Purpose

The company's sensitive-domain list (banking, health, personal email) that the agents never log,
and who can change it, the signup defaults included.

## ADDED Requirements

### Requirement: Company admins edit the sensitive list; managers read it
<!-- source: D4 · Plan-v3.5 §4.4 "Monitoring policy" · authenticate-users/role-access -->
`POST /v1/sensitive-domains` and `DELETE /v1/sensitive-domains/:id` SHALL be accepted only from a `company_admin`, and `GET /v1/sensitive-domains` MUST return `id`, `pattern`, `is_default` and `created_at` to a `company_admin` and a `manager`. An `it_admin` MUST get `403 FORBIDDEN` on every route here. A duplicate `lower(pattern)` MUST return `409 CONFLICT`.

#### Scenario: An admin adds a health portal
- **WHEN** a company admin posts `{ "pattern": "myclinic.example" }`
- **THEN** the response is `201` with `is_default` false

#### Scenario: A duplicate in another case
- **WHEN** `bank.example` is listed and an admin posts `Bank.Example`
- **THEN** the response is `409` with `code` `CONFLICT`

#### Scenario: A manager reads the list
- **WHEN** a manager calls `GET /v1/sensitive-domains`
- **THEN** the response lists the company's entries
- **AND** a manager's `POST` gets `403` with `code` `FORBIDDEN`

#### Scenario: An IT admin removes an entry
- **WHEN** an `it_admin` sends `DELETE /v1/sensitive-domains/:id`
- **THEN** the response is `403` with `code` `FORBIDDEN`

### Requirement: Defaults can be removed like any other entry
<!-- source: D4 · Plan-v3.5 §6.2 "sensitive_domains" -->
Rows with `is_default` true, seeded at signup by `provision-companies`, SHALL be removable by a `company_admin` through the same route as any other entry. A removed default MUST NOT be restored by the API.

#### Scenario: An admin removes a default
- **WHEN** an admin deletes a row with `is_default` true
- **THEN** it is gone from the list and from the next policy

#### Scenario: A removed default is added back by hand
- **WHEN** an admin removes a default and later posts the same pattern
- **THEN** the response is `201` with `is_default` false

#### Scenario: Every entry removed
- **WHEN** an admin removes every sensitive domain
- **THEN** the next policy carries `sensitive_domains` as an empty array

### Requirement: A sensitive domain is a bare host name
<!-- source: D4 · Mac track-and-block-websites "sensitive-domain-exclusion" -->
A `pattern` SHALL be stored lower-cased as a valid host name of at most 253 characters with no scheme, path, wildcard or IP address; it covers every subdomain. Anything else MUST return `422 VALIDATION_FAILED`.

#### Scenario: A wildcard
- **WHEN** an admin posts `*.bank.example`
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

#### Scenario: The longest host name
- **WHEN** an admin posts a valid host name of exactly 253 characters
- **THEN** the response is `201`
- **AND** one of 254 characters gets `422` with `code` `VALIDATION_FAILED`

### Requirement: A sensitive-list change reaches every device's policy
<!-- source: B5 · D8 -->
Every insert or delete of a `sensitive_domains` row SHALL raise `companies.policy_version` in the same transaction.

#### Scenario: A domain is added
- **WHEN** an admin adds a sensitive domain
- **THEN** `companies.policy_version` rises and the next policy lists it

### Requirement: Sensitive-domain IDs stay inside the company
<!-- source: B2 · Plan-v3.5 §6.1 -->
`DELETE /v1/sensitive-domains/:id` on an ID that is not an entry of the caller's company, including one already deleted, SHALL return `404 NOT_FOUND` and change nothing.

#### Scenario: Another company's entry
- **WHEN** a company admin deletes an entry ID of another company
- **THEN** the response is `404` with `code` `NOT_FOUND` and that entry stays in the other company's policy
