## Purpose

The company's website block list: who can edit it, the two rule types the agents enforce, and how
a regex an admin writes is turned into `url` patterns or refused.

## ADDED Requirements

### Requirement: Admins and IT edit the block list; managers read it
<!-- source: PRD "Permission matrix" · Plan-v3.5 §4.4 "Monitoring policy" -->
`POST /v1/block-rules`, `PATCH /v1/block-rules/:id` (`pattern`, `reason`) and `DELETE /v1/block-rules/:id` SHALL be accepted from a `company_admin` or `it_admin` and set `created_by` on create; a `manager` MUST get `403 FORBIDDEN`. `GET /v1/block-rules` MUST return `id`, `type`, `pattern`, `reason`, `created_at` to all three roles. A duplicate `(type, lower(pattern))` MUST return `409 CONFLICT`.

#### Scenario: IT blocks a site
- **WHEN** an `it_admin` posts `{ "type": "domain", "pattern": "games.example" }`
- **THEN** the response is `201` and the rule is listed

#### Scenario: The same domain in another case
- **WHEN** a `domain` rule `games.example` exists and an admin posts `Games.Example`
- **THEN** the response is `409` with `code` `CONFLICT`

#### Scenario: The same pattern as a domain and as a url rule
- **WHEN** a `domain` rule `games.example` exists and an admin posts a `url` rule `games.example`
- **THEN** the response is `201`

#### Scenario: Two admins add the same rule at once
- **WHEN** two identical creates run concurrently
- **THEN** one gets `201` and the other `409` with `code` `CONFLICT`, and one row exists

#### Scenario: An edit that duplicates another rule
- **WHEN** an admin patches a rule's `pattern` to one another rule of the same type holds
- **THEN** the response is `409` with `code` `CONFLICT` and the rule is unchanged

#### Scenario: A manager tries to delete a rule
- **WHEN** a manager sends `DELETE /v1/block-rules/:id`
- **THEN** the response is `403` with `code` `FORBIDDEN`

### Requirement: A domain rule is a bare host name
<!-- source: D39 · policy-model.md "Domain matching" -->
A `domain` rule's `pattern` SHALL be stored lower-cased as a valid host name with no scheme, port, path, wildcard or IP address; it covers the domain and every subdomain. Anything else MUST return `422 VALIDATION_FAILED`.

#### Scenario: A URL entered as a domain
- **WHEN** an admin posts a `domain` rule `https://games.example/play`
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

#### Scenario: Upper-case input
- **WHEN** an admin posts a `domain` rule `Games.Example`
- **THEN** it is stored as `games.example`

#### Scenario: An IP address
- **WHEN** an admin posts a `domain` rule `10.0.0.1`
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

#### Scenario: An edit that breaks the type
- **WHEN** an admin patches a `domain` rule's `pattern` to `games.example/play`
- **THEN** the response is `422` with `code` `VALIDATION_FAILED` and the rule is unchanged

### Requirement: A url rule is a Chrome URLBlocklist filter
<!-- source: D39 · Mac track-and-block-websites "browser-url-blocking" -->
A `url` rule's `pattern` SHALL be accepted only in the Chrome `URLBlocklist` filter format: optional scheme, a host (a leading `.` for the exact host only), optional port, optional path prefix and optional query. A pattern outside that format MUST return `422 VALIDATION_FAILED`.

#### Scenario: A path rule
- **WHEN** an admin posts a `url` rule `youtube.com/shorts`
- **THEN** the rule is saved with `type` `url`

#### Scenario: A pattern over the stored length
- **WHEN** an admin posts a `url` rule longer than 2,048 characters
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

### Requirement: Regex input is compiled to url patterns or refused
<!-- source: D39 · Plan-v3.5 §4.3 "Regex rules" · Mac track-and-block-websites "browser-url-blocking" -->
A create with `type` `regex` SHALL be compiled into one or more `url` rules when it is an anchored literal host, optionally with `(www\.)?` or an alternation of literal hosts, followed by a literal path prefix and an optional trailing `.*`; the created rules MUST be returned. Any other regex MUST return `422 VALIDATION_FAILED`. No rule MUST be stored with type `regex`.

#### Scenario: A simple prefix regex
- **WHEN** an admin posts `{ "type": "regex", "pattern": "^https?://(www\\.)?reddit\\.com/r/.*" }`
- **THEN** `url` rules covering `reddit.com/r/` are created and returned

#### Scenario: A regex that cannot be expressed
- **WHEN** an admin posts a regex with a character class in the host
- **THEN** the response is `422` with `code` `VALIDATION_FAILED` and nothing is written

#### Scenario: A compiled rule already exists
- **WHEN** a regex compiles to two `url` rules and one of them is already stored
- **THEN** the response is `409` with `code` `CONFLICT` and neither rule is written

### Requirement: A block-list change reaches every device's policy
<!-- source: B5 · D8 · Mac track-and-block-websites "system-blocking" -->
Every create, update or delete of a `block_rules` row SHALL raise `companies.policy_version` in the same transaction, so every device of the company receives the change on its next policy fetch.

#### Scenario: A rule is removed
- **WHEN** an admin deletes a rule
- **THEN** `companies.policy_version` rises
- **AND** the next policy no longer carries the rule

### Requirement: Rule IDs stay inside the company
<!-- source: B2 · Plan-v3.5 §6.1 · PRD "Permission matrix" -->
`PATCH` and `DELETE /v1/block-rules/:id` on an ID that is not a rule of the caller's company, including one already deleted, SHALL return `404 NOT_FOUND` and change nothing; `GET /v1/block-rules` MUST list only the caller's company's rules.

#### Scenario: Another company's rule
- **WHEN** an `it_admin` deletes a rule ID of another company
- **THEN** the response is `404` with `code` `NOT_FOUND` and both companies' `policy_version` are unchanged

#### Scenario: Deleted twice
- **WHEN** an admin deletes a rule that was already deleted
- **THEN** the response is `404` with `code` `NOT_FOUND`

### Requirement: The block list names who added each rule
<!-- source: Plan-v3.5 §4.5 "Policy" -->
`GET /v1/block-rules` rows SHALL carry `created_by_name`, the name of the `users` row in `created_by`, or `null` when there is none.

#### Scenario: A rule added by IT
- **WHEN** an IT admin named Rafi added a rule and a manager lists the block list
- **THEN** that row carries `created_by_name` `Rafi`
