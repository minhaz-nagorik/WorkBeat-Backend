## Purpose

How WorkBeat staff publish and withdraw agent and Downloader packages per platform and
architecture, and how the global and effective minimum agent versions follow from them.

## ADDED Requirements

### Requirement: Staff publish a release
<!-- source: Plan-v3.5 §4.6 · D40 · D41 · data-model.md "agent_releases" -->
`POST /v1/staff/agent-releases` SHALL let a `super_admin` create an `agent_releases` row with `product` (`agent` or `downloader`), `platform`, `arch`, `version` and `min_supported` (both `x.y.z`), `storage_path`, `sha256`, `signature` (required for macOS; `null` or omitted for Windows, whose MSIs are unsigned, W35; an empty string MUST get `422`), `size_bytes` and `release_notes`, with `published_by` the caller, and return `201`. The object MUST exist in the private `agents` bucket with `size_bytes`, or the request gets `422 VALIDATION_FAILED`.

#### Scenario: A new Mac package
- **WHEN** staff publish agent 1.0.5 for `macos` `universal` with an uploaded object
- **THEN** a release row exists with `published_by` the caller

#### Scenario: A company user tries to publish
- **WHEN** a company admin calls `POST /v1/staff/agent-releases`
- **THEN** the response is `403 FORBIDDEN`

#### Scenario: The object size differs
- **WHEN** staff publish with `size_bytes` one byte different from the stored object
- **THEN** the response is `422 VALIDATION_FAILED` and no row is written

#### Scenario: Two staff publish the same version at once
- **WHEN** two `POST /v1/staff/agent-releases` for one `(product, platform, arch, version)` are handled concurrently
- **THEN** one gets `201` and the other `409 CONFLICT`

### Requirement: Platform and architecture match the packaging
<!-- source: W31 · package-and-deploy-macos/installer-package · package-and-deploy-windows/installer-package -->
A `macos` release SHALL have `arch` `universal`, and a `windows` release `x64` or `arm64`. `min_supported` MUST NOT be above `version`. A violation MUST get `422 VALIDATION_FAILED`; an existing `(product, platform, arch, version)` MUST get `409 CONFLICT`.

#### Scenario: One MSI for both architectures
- **WHEN** staff publish a `windows` agent with `arch` `universal`
- **THEN** the response is `422 VALIDATION_FAILED`

#### Scenario: The same version twice
- **WHEN** staff publish `windows` `x64` agent 1.0.5 a second time
- **THEN** the response is `409 CONFLICT`

#### Scenario: A withdrawn version is published again
- **WHEN** staff publish a `(product, platform, arch, version)` whose release was withdrawn
- **THEN** the response is `409 CONFLICT`, so a fixed build needs a new version

#### Scenario: A version that is not x.y.z
- **WHEN** staff publish `version` `1.0` or `1.0.5-beta`
- **THEN** the response is `422 VALIDATION_FAILED`

### Requirement: Staff withdraw a release and list releases
<!-- source: Plan-v3.5 §4.6 -->
`POST /v1/staff/agent-releases/:id/withdraw` SHALL set `withdrawn_at` for a `super_admin`; withdrawing a withdrawn release MUST return it unchanged. `GET /v1/staff/agent-releases` SHALL list every release, newest first, with `withdrawn_at`. A withdrawn release MUST NOT be offered for download or update.

#### Scenario: A broken build is pulled
- **WHEN** staff withdraw `macos` agent 1.0.6
- **THEN** policies and downloads offer the newest live release instead

#### Scenario: The only release for a platform is withdrawn
- **WHEN** staff withdraw the only live `windows` `arm64` agent release
- **THEN** ARM64 policies carry null `update_package_url` and `update_package_sha256`
- **AND** `GET /v1/downloads` leaves out the `windows` `arm64` agent

#### Scenario: A company user withdraws
- **WHEN** an `it_admin` calls `POST /v1/staff/agent-releases/:id/withdraw`
- **THEN** the response is `403 FORBIDDEN`

### Requirement: The global minimum comes from the newest live release
<!-- source: Plan-v3.5 §4.6 "set global minimum version" · data-model.md "agent_releases" -->
The global minimum for a platform SHALL be the greatest `min_supported` among the non-withdrawn `agent` releases with that platform's highest `version`, or none when no such release exists.

#### Scenario: A release raises the floor
- **WHEN** staff publish `macos` agent 1.1.0 with `min_supported` 1.0.4
- **THEN** the global minimum for `macos` is 1.0.4

#### Scenario: An older version published later
- **WHEN** staff publish `macos` agent 1.0.7 after 1.1.0 is live
- **THEN** 1.1.0 stays the newest release and the global minimum still comes from it

#### Scenario: The newest release is withdrawn
- **WHEN** 1.1.0 with `min_supported` 1.0.4 is withdrawn and 1.0.6 with `min_supported` 1.0.0 is the newest live
- **THEN** the global minimum for `macos` is 1.0.0

#### Scenario: Numeric order
- **WHEN** releases 1.0.9 and 1.0.10 are live
- **THEN** 1.0.10 is the newest

### Requirement: The effective minimum is the greater of global and company
<!-- source: Plan-v3.5 §4.4 "Deployment", §5.7 · data-model.md "companies" -->
A company's effective minimum for a platform SHALL be the greater, by numeric `x.y.z` comparison, of the global minimum and `companies.min_agent_version`, and MUST be what `min_agent_version` in policy and the `outdated` badge use.

#### Scenario: A company sets a higher floor
- **WHEN** the global minimum is 1.0.4 and the company's is 1.0.10
- **THEN** the effective minimum is 1.0.10

#### Scenario: No live release and no company floor
- **WHEN** a platform has no live `agent` release and `companies.min_agent_version` is null
- **THEN** the effective minimum is null and no device is `outdated`

### Requirement: A release change reaches every policy
<!-- source: B5 · D8 · serve-agent-policy/agent-policy -->
Publishing or withdrawing an `agent` release SHALL give every company a new `companies.policy_version`, so the next heartbeat signals a policy fetch carrying the new minimum and update package.

#### Scenario: A new release is published
- **WHEN** staff publish a `windows` `arm64` agent release
- **THEN** every device's next heartbeat carries a higher `policy_version`

#### Scenario: A Downloader release
- **WHEN** staff publish or withdraw a `downloader` release
- **THEN** no `companies.policy_version` changes

### Requirement: Staff upload a release package
<!-- source: Plan-v3.5 §4.6 · B26 -->
`POST /v1/staff/agent-releases/upload-url` with `product`, `platform`, `arch` and `version` SHALL return, to a `super_admin`, `upload_url` (a signed `PUT` into the private `agents` bucket), its `storage_path` and `expires_at`. Publishing with that `storage_path` MUST then check the object's size and SHA-256.

#### Scenario: Staff upload a new macOS agent
- **WHEN** staff request an upload URL for `agent` `macos` `universal` `1.5.0` and `PUT` the package
- **THEN** publishing with the returned `storage_path`, `size_bytes` and `sha256` answers `201`
