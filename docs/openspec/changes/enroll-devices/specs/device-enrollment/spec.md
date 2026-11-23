## Purpose

`POST /v1/devices/enroll`: how an agent exchanges its single-use enrollment token for a device key,
how the seat is taken at that moment, and how an enrollment makes a new binding, keeps the live binding of the same employee, or is refused
while the device ID is bound to another employee.

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

### Requirement: Enrollment checks run in a fixed order
<!-- source: D43 · D48 · Plan-v3.5 §5.3 -->
`POST /v1/devices/enroll` SHALL check, in this order, and answer with the first that fails: the token (`404`/`403` token codes), the company's standing (`402`), the employee (`404 EMPLOYEE_NOT_FOUND`), the device ID's live binding (`409 DEVICE_ASSIGNED`), then the seat (`403 SEAT_LIMIT_EXCEEDED`).

#### Scenario: A full company and a device bound to someone else
- **WHEN** the company has no free seat and the device ID's live binding belongs to another employee
- **THEN** the response is `409 DEVICE_ASSIGNED`, telling IT to release the device first

#### Scenario: A suspended company and a device bound to someone else
- **WHEN** the company is suspended and the device ID is bound to another employee
- **THEN** the response is `402 LICENSE_SUSPENDED`

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
<!-- source: D47 · B8 -->
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

### Requirement: An enrollment with no live binding makes a new binding
<!-- source: D3 · D44 · D48 · Plan-v3.5 §4.4 "Device binding" · Plan-v3.5 §5.3 · agent-contract.md "Payload fields" -->
When the company has no device with the request's `hardware_id` and `released_at` NULL (no live binding), the API SHALL insert a `devices` row (a new binding) with the request's identity fields, the token's employee, `enrollment_token_id` and a new random device key stored only as `key_hash`, take a seat, set the token's `used_at` in the same transaction, and return `201` with `device_id`, `device_key`, `outcome` `new_binding` and `notice_required` true.

#### Scenario: First install
- **WHEN** a Mac enrolls with a valid token and a new `hardware_id`
- **THEN** the response is `201` with `device_id`, `device_key`, `outcome` `new_binding` and `notice_required` true
- **AND** the company's seats used rises by one and the token's `used_at` is set

#### Scenario: The same token twice at once
- **WHEN** two enroll requests with one token run concurrently
- **THEN** exactly one succeeds and the other gets `403` `ENROLLMENT_TOKEN_EXHAUSTED`

#### Scenario: The same hardware in another company
- **WHEN** a token of company A enrolls a `hardware_id` that company B already has enrolled
- **THEN** a new row is written in company A
- **AND** company B's row, key and seat are unchanged

#### Scenario: A reinstall produced a new device ID
- **WHEN** an employee's Mac is reinstalled and the agent enrolls with a `hardware_id` that has no live binding
- **THEN** the response is `201` with `outcome` `new_binding` and a second seat is taken
- **AND** the old binding keeps its seat until it is released

### Requirement: An enrollment for the live binding's employee keeps the binding
<!-- source: D2 · D43 · D46 · D48 · Plan-v3.5 §5.3 "Re-enrollment and seats" -->
When the company has a live binding with the request's `hardware_id` and the token's `employee_id`, the API SHALL update that row: new `key_hash` and `key_issued_at` (the old key stops working), identity fields from the request, and return `201` with the same `device_id`, `outcome` `same_binding` and `notice_required` false. The row MUST keep its seat without counting twice.

#### Scenario: A reinstall
- **WHEN** an enrolled Mac is reinstalled and enrolls for the same employee with a new token
- **THEN** the response carries the same `device_id`, a new `device_key`, `outcome` `same_binding` and `notice_required` false
- **AND** the seat count is unchanged and the old key gets `401 DEVICE_REVOKED`

#### Scenario: The same hardware enrolls twice at once
- **WHEN** two enroll requests with different valid tokens for the same employee and the same `hardware_id` run concurrently and no row exists yet
- **THEN** both get `201` with the same `device_id`, one row exists, and it holds one seat
- **AND** only the key of the request that committed last authenticates, and both tokens have `used_at` set

### Requirement: An enrollment for another employee while the binding is live is refused
<!-- source: D48 · D47 · Plan-v3.5 §5.3 step 6 · Plan-v3.5 §4.4 "Device binding" -->
When the company has a live binding with the request's `hardware_id` whose `employee_id` is not the token's, the API SHALL return `409 DEVICE_ASSIGNED`. It MUST write and change no `devices` row, MUST leave the old key working and MUST leave the token's `used_at` NULL.

#### Scenario: Setup for a new employee before the release
- **WHEN** a Mac bound to employee A enrolls with a token issued for employee B
- **THEN** the response is `409` with `code` `DEVICE_ASSIGNED`
- **AND** the row still names employee A, A's key still authenticates and B's token keeps `used_at` NULL

#### Scenario: The same device after its release
- **WHEN** the Mac bound to employee A is released and then enrolls with a token for employee B
- **THEN** the response is `201` with `outcome` `new_binding` for employee B

### Requirement: A re-enrollment while the old key is live raises a duplicate alert
<!-- source: D46 · D2 · D48 · Plan-v3.5 §4.4 "Duplicate device ID alert" · B34 -->
When an enrollment keeps a binding whose replaced key had a heartbeat in the last 15 minutes, the API SHALL still enroll as above and MUST insert one server-made `tamper_events` row with `event_type` `duplicate_device_id` for that device, listed in the alerts feed like any unresolved event. Only the backend raises this type.

#### Scenario: Two machines report one device ID
- **WHEN** a Mac whose current key sent a heartbeat 5 minutes ago re-enrolls for the same employee
- **THEN** the response is `201` with `outcome` `same_binding`
- **AND** one unresolved `duplicate_device_id` event exists for that device

#### Scenario: A reinstall after a quiet hour
- **WHEN** a Mac whose last heartbeat was 40 minutes ago re-enrolls for the same employee
- **THEN** no `duplicate_device_id` event is written

### Requirement: A released device enrolls as a new binding
<!-- source: D38 · D48 · Plan-v3.5 §5.3 · Plan-v3.5 §5.3 "Re-enrollment and seats" -->
A device whose `hardware_id` matches only rows with `released_at` set SHALL be enrolled as a new binding: a new row with a new `device_id` for the token's employee, taking a seat, with `outcome` `new_binding`. The released row MUST stay unchanged.

#### Scenario: A released Mac comes back
- **WHEN** a released Mac enrolls with a fresh token from a new Downloader run
- **THEN** a new `devices` row is created with a new `device_id`
- **AND** the released row keeps its `released_at`

#### Scenario: A returned Mac is reinstalled again
- **WHEN** hardware has one released row and one later live row, and enrolls once more for the live row's employee
- **THEN** the live row is kept and the released row is untouched

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
