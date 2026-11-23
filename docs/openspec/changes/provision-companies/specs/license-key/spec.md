## Purpose

The one licence key each company installs devices with: its format and storage, who sees it in
the portal, and how the seats it installs against are counted.

## ADDED Requirements

### Requirement: Each company has one licence key
<!-- source: D43 · B6 · PRD "Purchase, license and install" -->
Each company SHALL have one `licenses` row whose key has the form `WB-XXXX-XXXX-XXXX-XXXX` (upper-case letters and digits) and is stored as `key_hash` (SHA-256 of the normalised key), `key_ciphertext` (AES-256-GCM with the key from the environment) and `key_last4`. The plaintext MUST NOT be stored or logged.

#### Scenario: The key is stored
- **WHEN** a licence key is generated
- **THEN** `key_hash`, `key_ciphertext` and `key_last4` are set and no column holds the plaintext

#### Scenario: The key is typed in lower case
- **WHEN** a key is presented in lower case with surrounding spaces
- **THEN** it normalises to the same `key_hash`

#### Scenario: A generated key collides with an existing hash
- **WHEN** a newly generated key's `key_hash` already exists
- **THEN** a new key is generated and the transaction still creates one `licenses` row

### Requirement: Admins and IT admins see the masked key
<!-- source: D43 · Plan-v3.5 §4.5 "Deployment", §5.3 step 1 -->
`GET /v1/license` SHALL return, to `company_admin` and `it_admin` only, `key_masked` (`WB-••••-••••-••••-` and `key_last4`), `plan`, `seat_limit`, `seats_used` and `key_reset_at`. A `manager` MUST get `403 FORBIDDEN`.

#### Scenario: An IT admin opens Deployment
- **WHEN** an `it_admin` calls `GET /v1/license`
- **THEN** the response carries `key_masked` ending in the last four characters and `seats_used`

#### Scenario: Unlimited seats
- **WHEN** an Enterprise company with `seat_limit` NULL calls `GET /v1/license`
- **THEN** `seat_limit` is `null` and `seats_used` is the counted value

#### Scenario: A suspended company opens Deployment
- **WHEN** an `it_admin` of a `suspended` company calls `GET /v1/license`
- **THEN** the response is `200`

### Requirement: Admins and IT admins can reveal the key
<!-- source: D43 · B6 -->
`POST /v1/license/reveal` SHALL decrypt `key_ciphertext` and return `key` to `company_admin` and `it_admin` only, with `Cache-Control: no-store`. A `manager` MUST get `403 FORBIDDEN`.

#### Scenario: An admin copies the key
- **WHEN** a company admin calls `POST /v1/license/reveal`
- **THEN** the response carries the full key that the welcome email carried

#### Scenario: Reveal right after a staff reissue
- **WHEN** staff reissue the key and a company admin then calls `POST /v1/license/reveal`
- **THEN** the response carries the new key, never the old one

#### Scenario: A manager tries to reveal
- **WHEN** a `manager` calls `POST /v1/license/reveal`
- **THEN** the response is `403` with `code` `FORBIDDEN` and nothing is decrypted

### Requirement: Seats are counted from devices, never stored
<!-- source: D43 · B4 · Plan-v3.5 §5.3 "Re-enrollment and seats" -->
`seats_used` SHALL be the number of the company's `devices` with `released_at` NULL, counted on read. Seats MUST belong to the company, not the key, and no column MUST hold a seat count.

#### Scenario: A released device frees its seat
- **WHEN** a company has 10 devices and one is released
- **THEN** `seats_used` is 9

#### Scenario: A released device and the last free seat
- **WHEN** a Starter company has 10 devices of which one is released
- **THEN** `seats_used` is 9 and one more device can enroll

#### Scenario: More seats used than the limit
- **WHEN** a company has 30 active devices and its `seat_limit` was lowered to 10
- **THEN** `seats_used` is 30 and `seat_limit` is 10

### Requirement: Only staff reissue the key
<!-- source: D43 · Plan-v3.5 §4.4 "Licence key" -->
No company route SHALL change `key_hash`, `key_ciphertext` or `key_last4`. Reissue is the staff action specified by `administer-platform` (`staff-license-reissue`).

#### Scenario: A company admin asks for a new key
- **WHEN** a company admin calls any company route to reset the key
- **THEN** no route exists for it and the key is unchanged

### Requirement: IT can read the uninstall token
<!-- source: D19 · D40 · B6 · Plan-v3.5 §5.3 "Uninstall token" -->
`POST /v1/license/uninstall-token/reveal` SHALL return the company's uninstall token, decrypted from `companies.uninstall_token_ciphertext`, to a `company_admin` or `it_admin` only. Every other role MUST get `403 FORBIDDEN`, and the token MUST NOT be logged.

#### Scenario: IT prepares an uninstall
- **WHEN** an `it_admin` calls `POST /v1/license/uninstall-token/reveal`
- **THEN** the response carries the plain uninstall token whose hash is in every device's policy

#### Scenario: A manager asks for the uninstall token
- **WHEN** a `manager` calls `POST /v1/license/uninstall-token/reveal`
- **THEN** the response is `403` with `code` `FORBIDDEN`
