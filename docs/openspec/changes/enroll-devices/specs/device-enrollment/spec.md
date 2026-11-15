## Purpose

`POST /v1/devices/enroll`: how an agent exchanges its single-use enrollment token for a device key,
how the seat is taken at that moment, and how the same hardware reuses its row.

## ADDED Requirements

### Requirement: The enrollment token is checked first
<!-- source: D26 · D43 · B3 · agent-contract.md "Status and code catalog" -->
`POST /v1/devices/enroll` SHALL take the token from `Authorization: Bearer` and resolve its SHA-256 through `auth_enrollment_token`. An unknown token MUST return `404 ENROLLMENT_TOKEN_INVALID`; a token with `used_at` set MUST return `403 ENROLLMENT_TOKEN_EXHAUSTED`; otherwise one past `expires_at` MUST return `403 ENROLLMENT_TOKEN_EXPIRED`.

#### Scenario: A token deleted by a key reissue
- **WHEN** an agent enrolls with an unused token whose row a reissue deleted
- **THEN** the response is `404` with `code` `ENROLLMENT_TOKEN_INVALID`

#### Scenario: A used token
- **WHEN** a second device enrolls with a token that already enrolled one
- **THEN** the response is `403` with `code` `ENROLLMENT_TOKEN_EXHAUSTED`

#### Scenario: A token from two days ago
- **WHEN** an unused token is presented 25 hours after it was issued
- **THEN** the response is `403` with `code` `ENROLLMENT_TOKEN_EXPIRED`

#### Scenario: A used token that has also expired
- **WHEN** a token with `used_at` set is presented after its `expires_at`
- **THEN** the response is `403` with `code` `ENROLLMENT_TOKEN_EXHAUSTED`

#### Scenario: Exactly at the expiry
- **WHEN** an unused token is presented at its `expires_at`
- **THEN** the response is `403` with `code` `ENROLLMENT_TOKEN_EXPIRED`

#### Scenario: The response to a successful enrollment is lost
- **WHEN** an enrollment committed, its response never reached the agent and the agent retries with the same token
- **THEN** the retry gets `403` with `code` `ENROLLMENT_TOKEN_EXHAUSTED` and the device key is not returned again
- **AND** a new token for the same hardware re-enrolls the same row without taking a second seat

### Requirement: The company must be able to take a device
<!-- source: D29 · D30 · D43 · B4 -->
After the token check the API SHALL return `402 LICENSE_SUSPENDED` when the company is `suspended` and `402 LICENSE_EXPIRED` when it is `expired`. A device that would take a seat beyond `licenses.seat_limit` MUST be refused by the `devices_seat` trigger with `403 SEAT_LIMIT_EXCEEDED`. A refused enrollment MUST leave the token unused and write no device.

#### Scenario: Another device took the last seat
- **WHEN** two devices validated for the last seat and the second enrolls
- **THEN** the second gets `403` with `code` `SEAT_LIMIT_EXCEEDED`
- **AND** its token keeps `used_at` NULL

#### Scenario: Two enrollments race for the last seat
- **WHEN** a company at 49 of 50 seats receives two enrollments with different tokens and different `hardware_id`s at the same moment
- **THEN** exactly one gets `201` and the other gets `403` with `code` `SEAT_LIMIT_EXCEEDED`
- **AND** the seat count is 50, never 51

#### Scenario: Suspended after the token was issued
- **WHEN** a valid unused token is presented after the company was suspended
- **THEN** the response is `402` with `code` `LICENSE_SUSPENDED`
- **AND** the token keeps `used_at` NULL and works after the company is restored, until it expires

### Requirement: The device belongs to the token's employee
<!-- source: D44 · B8 -->
The enrolled device's `employee_id` SHALL be the token's `employee_id`. A body `employee_id` that differs MUST return `422 VALIDATION_FAILED`. When the token's employee has been archived since, the API MUST return `404 EMPLOYEE_NOT_FOUND`.

#### Scenario: A config file edited to another employee
- **WHEN** the body's `employee_id` differs from the token's
- **THEN** the response is `422` with `code` `VALIDATION_FAILED` and no device is written

#### Scenario: No employee_id in the body
- **WHEN** an enroll request omits `employee_id`
- **THEN** the device is enrolled with the token's `employee_id`

#### Scenario: The employee is archived between validation and enrollment
- **WHEN** a token was issued for an employee who was archived before the agent enrolled
- **THEN** the response is `404` with `code` `EMPLOYEE_NOT_FOUND`
- **AND** no device is written and the token keeps `used_at` NULL

### Requirement: A new device gets a new row and key
<!-- source: D3 · D44 · agent-contract.md "Payload fields" -->
When the company has no device with the request's `hardware_id` and `released_at` NULL, the API SHALL insert a `devices` row with the request's identity fields, the token's employee, `enrollment_token_id` and a new random device key stored only as `key_hash`, set the token's `used_at` in the same transaction, and return `201` with `device_id` and `device_key`.

#### Scenario: First install
- **WHEN** a Mac enrolls with a valid token and a new `hardware_id`
- **THEN** the response is `201` with `device_id` and `device_key`
- **AND** the company's seats used rises by one and the token's `used_at` is set

#### Scenario: The same token twice at once
- **WHEN** two enroll requests with one token run concurrently
- **THEN** exactly one succeeds and the other gets `403` `ENROLLMENT_TOKEN_EXHAUSTED`

#### Scenario: The same hardware in another company
- **WHEN** a token of company A enrolls a `hardware_id` that company B already has enrolled
- **THEN** a new row is written in company A
- **AND** company B's row, key and seat are unchanged

### Requirement: The same hardware reuses its row
<!-- source: D2 · D43 · Plan-v3.2 §5.3 "Re-enrollment and seats" -->
When the company has a device with the same `hardware_id` and `released_at` NULL, the API SHALL update that row: new `key_hash` and `key_issued_at` (the old key stops working), `employee_id` from the token, identity fields from the request, `deactivated_at` cleared. A row that held a seat MUST keep it without counting twice; a deactivated row MUST take a seat again.

#### Scenario: A reinstall
- **WHEN** an enrolled Mac is reinstalled and enrolls with a new token
- **THEN** the response carries the same `device_id` and a new `device_key`
- **AND** the seat count is unchanged and the old key gets `401 DEVICE_REVOKED`

#### Scenario: A deactivated Mac at a full company
- **WHEN** a deactivated Mac re-enrolls while every seat is used
- **THEN** the response is `403` with `code` `SEAT_LIMIT_EXCEEDED`
- **AND** the row stays deactivated and the token keeps `used_at` NULL

#### Scenario: The same hardware enrolls twice at once
- **WHEN** two enroll requests with different valid tokens and the same `hardware_id` run concurrently and no row exists yet
- **THEN** both get `201` with the same `device_id`, one row exists, and it holds one seat
- **AND** only the key of the request that committed last authenticates, and both tokens have `used_at` set

#### Scenario: Reinstalled for another employee
- **WHEN** an enrolled Mac re-enrolls with a token issued for a different employee
- **THEN** the row's `employee_id` is the new employee and its `policy_version` rises
- **AND** records stored before keep the previous `employee_id`

### Requirement: A released device enrolls as a new device
<!-- source: D38 · Plan-v3.2 §5.3 -->
A device whose `hardware_id` matches only rows with `released_at` set SHALL be enrolled as a new row with a new `device_id`, taking a seat. The released row MUST stay unchanged.

#### Scenario: A released Mac comes back
- **WHEN** a released Mac enrolls with a fresh token from a new Downloader run
- **THEN** a new `devices` row is created with a new `device_id`
- **AND** the released row keeps its `released_at`

#### Scenario: A returned Mac is reinstalled again
- **WHEN** hardware has one released row and one later active row, and enrolls once more
- **THEN** the active row is reused and the released row is untouched

### Requirement: A malformed enroll request writes nothing
<!-- source: B9 · D40 · agent-contract.md "Payload fields" -->
After the token check, an enroll body failing its `packages/shared` schema (missing or empty `hardware_id` or `hostname`, `os` not `macos` or `windows`, `arch` not `x64` or `arm64`, `enrolled_via` not `manual`) SHALL get `400 VALIDATION_FAILED`, MUST write no device and MUST leave the token unused.

#### Scenario: An empty hardware ID
- **WHEN** an agent enrolls with `hardware_id` ''
- **THEN** the response is `400` with `code` `VALIDATION_FAILED`
- **AND** the token keeps `used_at` NULL

#### Scenario: An unknown token with a bad body
- **WHEN** an unknown token is sent with a malformed body
- **THEN** the response is `404` with `code` `ENROLLMENT_TOKEN_INVALID`
