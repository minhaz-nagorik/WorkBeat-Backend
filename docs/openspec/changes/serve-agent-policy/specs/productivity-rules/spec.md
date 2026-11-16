## Purpose

The company's productivity rules that label an app or a domain productive, neutral or
unproductive in reports, and who can change them.

## ADDED Requirements

### Requirement: Company admins edit productivity rules; managers read them
<!-- source: PRD "Permission matrix" -->
`POST /v1/productivity-rules`, `PATCH /v1/productivity-rules/:id` (`category`) and `DELETE /v1/productivity-rules/:id` SHALL be accepted only from a `company_admin`. `GET /v1/productivity-rules` MUST return `id`, `match_type`, `pattern`, `category` to a `company_admin` and a `manager`. An `it_admin` MUST get `403 FORBIDDEN` on every route here.

#### Scenario: An admin marks a site unproductive
- **WHEN** an admin posts `{ "match_type": "domain", "pattern": "news.example", "category": "unproductive" }`
- **THEN** the response is `201` and the rule is listed

#### Scenario: An IT admin lists rules
- **WHEN** an `it_admin` calls `GET /v1/productivity-rules`
- **THEN** the response is `403` with `code` `FORBIDDEN`

#### Scenario: A manager tries to change a rule
- **WHEN** a manager sends `PATCH /v1/productivity-rules/:id`
- **THEN** the response is `403` with `code` `FORBIDDEN` and the rule is unchanged

### Requirement: A rule names an app or a domain and a category
<!-- source: PRD "Activity levels, productivity, calendar and timesheets" -->
`match_type` SHALL be `app` or `domain` and `category` `productive`, `neutral` or `unproductive`. A `domain` pattern MUST be a bare host name and an `app` pattern a non-empty app name or bundle ID. A duplicate `(match_type, lower(pattern))` MUST return `409 CONFLICT`; any other invalid value `422 VALIDATION_FAILED`.

#### Scenario: An unknown category
- **WHEN** an admin posts `category` `distracting`
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

#### Scenario: A duplicate in another case
- **WHEN** an `app` rule `Slack` exists and an admin posts an `app` rule `slack`
- **THEN** the response is `409` with `code` `CONFLICT`

#### Scenario: The same pattern as an app and a domain
- **WHEN** an `app` rule `zoom` exists and an admin posts a `domain` rule `zoom`
- **THEN** the response is `201`

#### Scenario: An empty app name
- **WHEN** an admin posts an `app` rule with `pattern` ''
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

### Requirement: Productivity rules are not part of agent policy
<!-- source: PRD "Activity levels, productivity, calendar and timesheets" -->
A productivity-rule change SHALL NOT change any `policy_version` or the policy body. Categories MUST be applied only when a report is read (`report-usage`), never stored on activity rows, so a changed rule re-categorises history.

#### Scenario: A rule changes category
- **WHEN** an admin changes a rule from `neutral` to `productive`
- **THEN** `companies.policy_version` is unchanged
- **AND** no `app_sessions` or `url_visits` row is written

### Requirement: Productivity-rule IDs stay inside the company
<!-- source: B2 · Plan-v3.5 §6.1 -->
`PATCH` and `DELETE /v1/productivity-rules/:id` on an ID that is not a rule of the caller's company, including one already deleted, SHALL return `404 NOT_FOUND` and change nothing.

#### Scenario: Another company's rule
- **WHEN** a company admin patches a rule ID of another company
- **THEN** the response is `404` with `code` `NOT_FOUND`
