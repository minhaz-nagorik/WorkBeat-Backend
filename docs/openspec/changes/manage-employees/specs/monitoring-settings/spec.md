## Purpose

The per-employee monitoring switches and screenshot interval that every device of that employee
receives in its policy, and the limits the company's screenshot tier puts on them.

## ADDED Requirements

### Requirement: Settings exist from the moment the employee does
<!-- source: D37 · PRD "Pricing" -->
Every employee SHALL have one `employee_monitoring_settings` row, created with the employee, with `activity`, `app_usage`, `window_titles` and `website_visits` true and `screenshot_interval_seconds` equal to the company's tier interval (`tier_interval(licenses.screenshot_tier)`, 0 when the tier is `off`).

#### Scenario: A company on the standard tier adds an employee
- **WHEN** an employee is created in a company whose `screenshot_tier` is `standard`
- **THEN** their settings have every switch true and `screenshot_interval_seconds` = 1800

#### Scenario: An employee added on tier off
- **WHEN** an employee is created in a company whose `screenshot_tier` is `off`
- **THEN** their `screenshot_interval_seconds` is 0

#### Scenario: Employees created by import
- **WHEN** an import creates 50 employees
- **THEN** each has one settings row with the tier defaults

### Requirement: Settings are read and changed per employee
<!-- source: D37 · PRD "Permission matrix" · B12 -->
`GET /v1/employees/:id/monitoring-settings` SHALL return the four switches, `screenshot_interval_seconds` and the company's `screenshot_tier` (B29) to a `company_admin`, and to a `manager` for their own team. `PUT` on the same path MUST be accepted only from a `company_admin`, MUST set `updated_by`, and MUST raise the employee's `policy_version`. Any other role MUST get `403 FORBIDDEN`.

#### Scenario: An admin turns window titles off
- **WHEN** an admin sends `PUT` with `window_titles` false
- **THEN** the row has `window_titles` false and a higher `policy_version`
- **AND** `updated_by` is the admin

#### Scenario: An IT admin reads settings
- **WHEN** an `it_admin` calls `GET /v1/employees/:id/monitoring-settings`
- **THEN** the response is `403` with `code` `FORBIDDEN`

#### Scenario: A manager tries to change settings
- **WHEN** a manager sends `PUT /v1/employees/:id/monitoring-settings` for a team member
- **THEN** the response is `403` with `code` `FORBIDDEN` and `policy_version` is unchanged

#### Scenario: Another company's employee
- **WHEN** a company admin calls `GET /v1/employees/:id/monitoring-settings` with an employee ID of another company
- **THEN** the response is `404` with `code` `NOT_FOUND`

### Requirement: The screenshot interval stays within the tier
<!-- source: B11 · PRD "Pricing" -->
`screenshot_interval_seconds` SHALL be one of 0, 600, 1800 or 3600, and either 0 or no shorter than the company's tier interval. With the tier `off` only 0 MUST be accepted. Any other value MUST return `422 VALIDATION_FAILED` and change nothing.

#### Scenario: More often than the tier
- **WHEN** an admin on the `light` tier (3600) sets 600
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

#### Scenario: Less often than the tier
- **WHEN** an admin on the `intensive` tier (600) sets 3600
- **THEN** the value is saved

#### Scenario: No screenshot add-on
- **WHEN** the tier is `off` and an admin sets 1800
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

#### Scenario: A value outside the set
- **WHEN** an admin sets `screenshot_interval_seconds` to 900 or -1
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

#### Scenario: Exactly the tier interval
- **WHEN** an admin on the `standard` tier (1800) sets 1800
- **THEN** the value is saved

#### Scenario: Tier off and only the switches change
- **WHEN** the tier is `off` and an admin sets `window_titles` false with `screenshot_interval_seconds` 0
- **THEN** the change is saved

#### Scenario: The tier is lowered while an admin saves
- **WHEN** an admin saves 600 on `intensive` while a subscription event lowers the tier to `light`
- **THEN** the employee ends at 3600 or at 0, never at 600 on `light`

### Requirement: Widening collection is only a policy change
<!-- source: D37 · Mac report-device-health "monitoring-features" · policy-model.md "When policy widens collection" -->
A settings change that turns a switch on or shortens the interval SHALL change only the settings row and its `policy_version`. The API MUST NOT change `notice_version` for it: the agent asks for the notice again when it sees the wider policy.

#### Scenario: Screenshots turned on
- **WHEN** an admin changes an employee's interval from 0 to 1800
- **THEN** the employee's `policy_version` rises
- **AND** `companies.notice_version` is unchanged
