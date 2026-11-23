## Purpose

`POST /v1/license/validate`, the Downloader's only call: it checks the licence key, the company and a
free seat, returns the company and its employees, and issues a single-use enrollment token bound
to the employee IT picked.

## ADDED Requirements

### Requirement: The licence key is resolved by its hash
<!-- source: D43 · B3 · B8 · agent-contract.md "Status and code catalog" -->
`POST /v1/license/validate` SHALL read the key only from the `X-License-Key` header and resolve its SHA-256 through `auth_license`. A missing or unknown key, including a key replaced by a reissue, MUST return `404 LICENSE_NOT_FOUND`. The request then MUST run in tenant scope of the key's company.

#### Scenario: A mistyped key
- **WHEN** the Downloader sends a key that matches no `licenses.key_hash`
- **THEN** the response is `404` with `code` `LICENSE_NOT_FOUND`

#### Scenario: The key before a reissue
- **WHEN** a key is sent after a super admin reissued it
- **THEN** the response is `404` with `code` `LICENSE_NOT_FOUND`

#### Scenario: No header at all
- **WHEN** the Downloader calls with no `X-License-Key` header and the key in the body
- **THEN** the response is `404` with `code` `LICENSE_NOT_FOUND`
- **AND** the body key is never read

### Requirement: Suspended and expired companies are refused
<!-- source: D29 · D30 · Plan-v3.5 §4.4 "Company, subscription and licence" -->
When the key's company has `status` `suspended` the API SHALL return `402 LICENSE_SUSPENDED`, and when `status` is `expired` it MUST return `402 LICENSE_EXPIRED`, at both steps and before any other check except the key lookup.

#### Scenario: A failed renewal
- **WHEN** the company was suspended for a failed payment and IT validates the key
- **THEN** the response is `402` with `code` `LICENSE_SUSPENDED` and no token is issued

#### Scenario: An ended subscription
- **WHEN** the company's `status` is `expired`
- **THEN** the response is `402` with `code` `LICENSE_EXPIRED`

#### Scenario: Suspended between step one and step two
- **WHEN** step 1 succeeded and the company is suspended before step 2
- **THEN** step 2 gets `402` with `code` `LICENSE_SUSPENDED` and no `enrollment_tokens` row is written

#### Scenario: A trial company
- **WHEN** a company in `trial` with a free seat validates its key
- **THEN** the response is `200` with no status code in the body

### Requirement: A free seat is checked and nothing is reserved
<!-- source: D43 · D47 · B4 · Plan-v3.5 §5.3 -->
At both steps the API SHALL return `403 SEAT_LIMIT_EXCEEDED` when the devices with `released_at` NULL number at least `licenses.seat_limit` (never for a NULL limit). Validation MUST NOT reserve or count a seat.

#### Scenario: The last seat
- **WHEN** a company at 49 of 50 seats validates the key twice from two Macs
- **THEN** both validations succeed
- **AND** the seat count is still 49

#### Scenario: No seat left
- **WHEN** a company at 50 of 50 seats validates the key
- **THEN** the response is `403` with `code` `SEAT_LIMIT_EXCEEDED`

#### Scenario: Released devices free their seats
- **WHEN** a company with a `seat_limit` of 50 has 50 devices, two of them released
- **THEN** validation succeeds because 48 seats are used

#### Scenario: An unlimited Enterprise licence
- **WHEN** `licenses.seat_limit` is NULL and the company has 5,000 devices holding seats
- **THEN** validation never answers `SEAT_LIMIT_EXCEEDED`

### Requirement: Step one returns the company and its employees
<!-- source: B8 · D42 · D47 -->
A request with no `employee_id` SHALL return `company_name` and `employees[]` with `id`, `name`, `email` and `department` for every non-archived employee of the company, ordered by `name`. It MUST write nothing.

#### Scenario: IT checks the key
- **WHEN** a valid key is sent with no `employee_id`
- **THEN** the response carries the company name and its active employees
- **AND** no `enrollment_tokens` row is written

#### Scenario: A company with no active employees
- **WHEN** a valid key is sent for a company that has no employee or only archived ones
- **THEN** the response is `200` with `employees` an empty array

### Requirement: Step two issues a single-use token for the picked employee
<!-- source: B8 · D26 · D43 · D47 · Plan-v3.5 §5.3 -->
A request with `employee_id` SHALL, when it names a non-archived employee of the company, write one `enrollment_tokens` row with `license_id`, `employee_id`, `token_hash` (SHA-256 of a random token) and `expires_at` = now + 24 h, and return the token and `expires_at` once. Any other `employee_id` MUST return `404 EMPLOYEE_NOT_FOUND`.

#### Scenario: IT picks an employee
- **WHEN** a valid key is sent with an active employee's `employee_id`
- **THEN** the response carries `enrollment_token` and `expires_at` 24 hours later
- **AND** only the token's SHA-256 is stored

#### Scenario: An archived employee
- **WHEN** the `employee_id` is archived or belongs to another company
- **THEN** the response is `404` with `code` `EMPLOYEE_NOT_FOUND` and no token is written

#### Scenario: Step two called twice for the same employee
- **WHEN** step 2 is called twice for one employee, for example after a lost response
- **THEN** two `enrollment_tokens` rows exist with different `token_hash` values
- **AND** both stay usable until each is used once or expires, and neither call revokes the other

#### Scenario: The employee is archived between the two steps
- **WHEN** step 1 listed an employee and an admin archived them before step 2
- **THEN** step 2 gets `404` with `code` `EMPLOYEE_NOT_FOUND` and no token is written

### Requirement: Step 2 also returns the agent package to install
<!-- source: B8 · W31 · D40 · Plan-v3.5 §5.1 -->
When step 2 carries `os` (`macos` or `windows`) and `arch` (`x64` or `arm64`), the response SHALL also carry `package_url`, a short-lived signed URL to the newest non-withdrawn `agent` release for that platform and architecture (the universal `.pkg` on macOS), and its `package_sha256`, chosen as `distribute-agents` defines.

#### Scenario: The Downloader installs on an ARM64 PC
- **WHEN** step 2 is called with `os` `windows` and `arch` `arm64`
- **THEN** `package_url` points at the newest ARM64 MSI and `package_sha256` is its hash

#### Scenario: The newest release was withdrawn
- **WHEN** the newest macOS `agent` release has `withdrawn_at` set and an older one does not
- **THEN** `package_url` points at the older release and `package_sha256` is its hash

### Requirement: Step two refuses an unknown platform
<!-- source: B8 · B9 · agent-contract.md "Payload fields" -->
When step 2 carries an `os` other than `macos` or `windows`, or an `arch` other than `x64` or `arm64`, the API SHALL return `400 VALIDATION_FAILED` and MUST write no `enrollment_tokens` row, so no token is issued without a package to install it.

#### Scenario: A Linux Downloader
- **WHEN** step 2 is called with `os` `linux`
- **THEN** the response is `400` with `code` `VALIDATION_FAILED`
- **AND** no `enrollment_tokens` row is written
