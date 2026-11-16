## Purpose

`GET /v1/agents/policy`: the one body that tells a device what to block, what to collect and when not
to, resolved for that device's employee, with a version and an ETag so unchanged policy costs a
`304`.

## ADDED Requirements

### Requirement: The policy carries exactly the contract fields
<!-- source: D8 · B9 · agent-contract.md "Payload fields" · Mac report-device-health "policy-refresh" -->
`GET /v1/agents/policy`, authenticated by `device-authentication`, SHALL return `policy_version`, `block_rules[]` (`id`, `type`, `pattern`, `reason`), `sensitive_domains[]`, `screenshot_interval_seconds`, `idle_threshold_seconds`, `min_agent_version`, `update_package_url`, `update_package_sha256`, `uninstall_token_hash`, `collection_notice` (`text`, `version`), `monitoring_features` and `monitoring_pauses[]`.

#### Scenario: An enrolled Mac fetches policy
- **WHEN** an enrolled device calls `GET /v1/agents/policy` with no `If-None-Match`
- **THEN** the response is `200` with every field above and an `ETag` header
- **AND** every `block_rules[].type` is `domain` or `url`

#### Scenario: A company with no rules
- **WHEN** a company has no block rule, no sensitive domain and the employee has no pause
- **THEN** `block_rules`, `sensitive_domains` and `monitoring_pauses` are empty arrays, never null or absent

#### Scenario: A suspended company's device
- **WHEN** a device of a suspended company calls `GET /v1/agents/policy`
- **THEN** the response is `402` with `code` `COMPANY_SUSPENDED` and no policy body or `ETag`

### Requirement: The policy is resolved for the device's employee
<!-- source: D37 · D31 · Mac report-device-health "monitoring-features", "monitoring-pause" -->
`monitoring_features` SHALL be the `activity`, `app_usage`, `window_titles` and `website_visits` of the device's employee's settings, and `screenshot_interval_seconds` their interval (0 when the tier is `off`). `monitoring_pauses[]` MUST hold `{ pause_id, starts_at, ends_at }` for that employee's pauses with `cancelled_at` NULL and `ends_at` after now. No other employee's data MUST appear.

#### Scenario: Two employees with different switches
- **WHEN** employee A has `window_titles` off and employee B has it on
- **THEN** A's devices receive `window_titles` false and B's receive true

#### Scenario: A cancelled and a future pause
- **WHEN** the employee has one cancelled pause and one starting tomorrow
- **THEN** `monitoring_pauses` holds only tomorrow's pause

#### Scenario: A pause in force and a future pause
- **WHEN** the employee has a pause that started an hour ago and one starting next week
- **THEN** `monitoring_pauses` holds both, the one in force first

#### Scenario: A pause ending now
- **WHEN** a pause's `ends_at` is equal to the server's now
- **THEN** it is not in `monitoring_pauses`

#### Scenario: The screenshot tier is off
- **WHEN** an employee's `screenshot_interval_seconds` is 600 and the company's `screenshot_tier` is `off`
- **THEN** the policy carries `screenshot_interval_seconds` 0

#### Scenario: A new binding on a used device
- **WHEN** a device bound to an employee with screenshots at 600 is released and set up for one at 0
- **THEN** the new binding's policy carries `screenshot_interval_seconds` 0 and the new employee's switches and pauses only
- **AND** the released binding's key gets `401 DEVICE_RELEASED` on `GET /v1/agents/policy`

### Requirement: Company-wide fields come from the company
<!-- source: D4 · D15 · D19 · D25 · D39 · Plan-v3.5 §4.4 "Monitoring policy" -->
`block_rules` and `sensitive_domains` (as pattern strings) SHALL be the company's rows, `idle_threshold_seconds`, `uninstall_token_hash` and `collection_notice` its `companies` columns. `min_agent_version` MUST be the effective minimum defined by `distribute-agents` (`agent-releases`): the greater of `companies.min_agent_version` and the platform's global minimum. `update_package_url` and `update_package_sha256` MUST be as `distribute-agents` sets them, else null.

#### Scenario: The company minimum is older than the global one
- **WHEN** the company's minimum is `1.2.0` and the newest macOS agent release has `min_supported` `1.4.0`
- **THEN** a Mac receives `min_agent_version` `1.4.0`

#### Scenario: The newest release was withdrawn
- **WHEN** the newest macOS agent release, with `min_supported` `1.5.0`, has `withdrawn_at` set and the one before has `1.4.0`
- **THEN** a Mac receives `min_agent_version` `1.4.0`

#### Scenario: Another company's rules
- **WHEN** company B blocks `games.example` and company A does not
- **THEN** no device of company A receives that rule

### Requirement: The version is the greatest of company, employee and device
<!-- source: B5 · D8 · D48 · Plan-v3.5 §6.2 "devices" -->
`policy_version` SHALL be `greatest(companies.policy_version, employee_monitoring_settings.policy_version, devices.policy_version)` for the binding's company, employee and row. `devices.policy_version` is set once at insert and MUST NOT change, because a binding's employee never changes. A binding's version MUST never be lower than one it received before.

#### Scenario: The employee's settings change
- **WHEN** an admin turns off `window_titles` for the binding's employee
- **THEN** the binding's next `policy_version` is higher than the one it had
- **AND** its `devices.policy_version` is unchanged

#### Scenario: Only the company changed
- **WHEN** a block rule is added and nothing else changes
- **THEN** every device of the company gets a `policy_version` higher than before

### Requirement: An unchanged policy answers 304
<!-- source: D8 · Mac report-device-health "policy-refresh" -->
The `ETag` SHALL be a hash of the resolved response body. `update_package_url` is re-signed at most once per release per UTC day (B16), so the ETag changes at most daily for it. A request whose `If-None-Match` equals the current `ETag` MUST get `304` with no body.

#### Scenario: Nothing changed since the last fetch
- **WHEN** a device sends `If-None-Match` with the ETag of its last policy and nothing changed
- **THEN** the response is `304` with no body

#### Scenario: A rule was added
- **WHEN** a block rule was added since the device's last fetch
- **THEN** the response is `200` with a new `ETag` and the new rule

#### Scenario: A stale ETag
- **WHEN** a device sends an `If-None-Match` from two policy versions ago
- **THEN** the response is `200` with the full current body and the current `ETag`

#### Scenario: The next UTC day's re-signing
- **WHEN** a device with an update offered fetches policy after 00:00 UTC with the previous day's ETag and nothing else changed
- **THEN** the first fetch that day is `200` with a re-signed `update_package_url` and a new `ETag`
- **AND** later fetches that day with the new `ETag` get `304`

### Requirement: The version and the body come from one snapshot
<!-- source: B2 · B5 · D8 · Mac report-device-health "policy-refresh" -->
`policy_version` and every field of the body SHALL be read in one database snapshot, so a response never pairs a version with a body older than it. A change committed while the policy is being built MUST appear either in both or in neither.

#### Scenario: A rule is added during a fetch
- **WHEN** an admin adds a block rule while a device's policy is being built
- **THEN** the response either carries the old version without the rule or a higher version with it
- **AND** a later heartbeat's `policy_version` makes the device fetch again when it got the old one
