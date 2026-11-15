## Purpose

How WorkBeat staff replace a company's licence key when it leaks: what changes, what stays the
same, and who is told the new key.

## ADDED Requirements

### Requirement: Staff reissue a company's licence key
<!-- source: D43 · Plan-v3.2 §4.4 "Licence key", §4.6 -->
`POST /v1/staff/companies/:id/license/reissue` SHALL be allowed to `super_admin` only. On the company's existing `licenses` row it MUST set a new key's `key_hash`, `key_ciphertext` and `key_last4` (format and storage as in `license-key`) and `key_reset_at`, and return the new `key` once with `Cache-Control: no-store`. No second `licenses` row MUST be created.

#### Scenario: Staff reissue a key
- **WHEN** a `super_admin` reissues company A's key
- **THEN** the response carries a new key `WB-XXXX-XXXX-XXXX-XXXX` and `key_reset_at` is set
- **AND** company A still has exactly one `licenses` row with the same `id`

#### Scenario: Two reissues in a row
- **WHEN** staff reissue a key and reissue it again a minute later
- **THEN** only the second new key works and `key_reset_at` is the second time

#### Scenario: A suspended or expired company
- **WHEN** staff reissue the key of a `suspended` or `expired` company
- **THEN** the key is reissued and the company's `status` is unchanged

### Requirement: The old key stops working at once
<!-- source: D43 · agent-contract.md "Status and code catalog" -->
After a reissue commits, the old key SHALL match no licence, so `/license/validate` with it answers `404 LICENSE_NOT_FOUND` (`enroll-devices`).

#### Scenario: The Downloader uses the old key
- **WHEN** the Downloader presents the key from before the reissue
- **THEN** the answer is `404` with `code` `LICENSE_NOT_FOUND`

#### Scenario: A validation in flight during the reissue
- **WHEN** `/license/validate` with the old key runs while the reissue commits
- **THEN** either it finishes first and its token is deleted by the reissue, or it answers `404 LICENSE_NOT_FOUND`

### Requirement: Unused enrollment tokens are deleted
<!-- source: D43 · agent-contract.md "Status and code catalog" -->
The reissue SHALL delete, in the same transaction, every `enrollment_tokens` row of that licence with `used_at` NULL, through `delete_unused_enrollment_tokens`. Used tokens MUST stay. A deleted token then answers `404 ENROLLMENT_TOKEN_INVALID` at `/devices/enroll`.

#### Scenario: An install was half-way through
- **WHEN** a token was issued from key A and not yet used when key A is reissued
- **THEN** `/devices/enroll` with that token answers `404 ENROLLMENT_TOKEN_INVALID`

#### Scenario: A licence with no tokens
- **WHEN** a company with no unused token is reissued
- **THEN** the reissue succeeds and deletes nothing

### Requirement: Devices and seats are unchanged
<!-- source: D43 · B4 · Plan-v3.2 §5.3 "Re-enrollment and seats" -->
A reissue SHALL change no `devices` row, and seats used MUST be the same before and after. Enrolled devices MUST keep working with their device keys.

#### Scenario: A full company
- **WHEN** a company with 50 of 50 seats used on key A is reissued to key B
- **THEN** it has 50 of 50 seats used on key B
- **AND** every enrolled device's next heartbeat succeeds

### Requirement: Company admins receive the new key
<!-- source: D43 · Plan-v3.2 §5.3 step 1 -->
After the reissue commits, the API SHALL email the new key through Resend to every enabled `company_admin` of the company. The key MUST NOT be logged.

#### Scenario: Two company admins
- **WHEN** a company with two enabled company admins has its key reissued
- **THEN** each admin receives one email with the new key

#### Scenario: Resend is down
- **WHEN** the new-key email cannot be sent
- **THEN** the reissue stays committed, staff still receive the key in the response and the failure is logged by company ID

#### Scenario: No enabled company admin
- **WHEN** the company has no enabled `company_admin`
- **THEN** no email is sent and the reissue still succeeds
