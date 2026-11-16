## Purpose

How the update fields in each device's policy are chosen and signed so an outdated agent can update
itself, and how a company sets its own minimum version.

## ADDED Requirements

### Requirement: The policy points at the newest package for the device
<!-- source: D40 · W31 · Plan-v3.5 §5.7 · serve-agent-policy/agent-policy -->
In `GET /v1/agents/policy` (route owned by `agent-policy`), `update_package_url` and `update_package_sha256` SHALL name the newest non-withdrawn `agent` release for the device's `os` and architecture: `universal` for `macos`, the device's `arch` for `windows`. With no such release both MUST be null.

#### Scenario: An ARM64 PC
- **WHEN** a `windows` `arm64` device fetches policy
- **THEN** `update_package_url` points at the newest live `windows` `arm64` MSI
- **AND** `update_package_sha256` is that release's `sha256`

#### Scenario: An Intel Mac
- **WHEN** a `macos` `x64` device fetches policy
- **THEN** `update_package_url` points at the newest live `macos` `universal` package

#### Scenario: Withdrawn newest, older live
- **WHEN** the newest `macos` release is withdrawn and an older one is live
- **THEN** `update_package_url` points at the older live release

### Requirement: The update URL is signed and outlives a cached policy
<!-- source: D40 · D8 · Plan-v3.5 §5.3 "Secret" -->
`update_package_url` SHALL be a signed URL to the private `agents` bucket, signed once per release per UTC day and valid until the end of the next UTC day, so it is identical all day and the body-hash ETag of `agent-policy` changes daily. A `304` MUST therefore never confirm an expired URL, and the URL MUST NOT be logged.

#### Scenario: Policy unchanged for two days
- **WHEN** a device fetches policy with an ETag issued 30 hours ago
- **THEN** it gets `200` with a valid `update_package_url`, not `304`

#### Scenario: Across UTC midnight
- **WHEN** a device fetches policy at 23:59 UTC and again at 00:01 UTC
- **THEN** the two `update_package_url` values differ and the first is still valid until the end of the new day

#### Scenario: Two API instances on one day
- **WHEN** two instances build the policy for one device on the same UTC day
- **THEN** both return the same `update_package_url` and ETag

### Requirement: The policy minimum is the effective minimum
<!-- source: Plan-v3.5 §4.4 "Deployment", §5.7 · package-and-deploy-macos/agent-updates -->
`min_agent_version` in each policy SHALL be the company's effective minimum for the device's platform as `agent-releases` defines it.

#### Scenario: A company floor above the global
- **WHEN** a company sets 1.0.10 and the global `macos` minimum is 1.0.4
- **THEN** its Macs' policy carries `min_agent_version` 1.0.10

### Requirement: Admins and IT set the company minimum
<!-- source: Plan-v3.5 §4.4 "Minimum agent version per company", §4.5 "Deployment" -->
`PUT /v1/deployment/min-agent-version` with `min_agent_version` (`x.y.z` or null) SHALL set `companies.min_agent_version` for a `company_admin` or `it_admin` and bump the company's `policy_version`. A `manager` MUST get `403 FORBIDDEN`; a malformed version, or one above the newest live `agent` release of any platform that has one, MUST get `422 VALIDATION_FAILED`.

#### Scenario: IT raises the floor
- **WHEN** an IT admin sets 1.0.6
- **THEN** devices below 1.0.6 show the `outdated` badge and receive the new minimum on their next policy fetch

#### Scenario: Clearing the company floor
- **WHEN** an IT admin sets `min_agent_version` to null
- **THEN** the effective minimum is the global minimum and `policy_version` rises

#### Scenario: A floor above every live release
- **WHEN** an IT admin sets 9.0.0 while the newest live agent of a platform is 1.1.0
- **THEN** the response is `422 VALIDATION_FAILED` and nothing changes

#### Scenario: Another company's devices
- **WHEN** company A's admin sets 1.0.6
- **THEN** company B's policies and `policy_version` are unchanged

### Requirement: A released device gets no update
<!-- source: D38 · Plan-v3.5 §5.7 -->
A released or deactivated device SHALL receive no policy and no update URL, because `device-authentication` answers it with `401`.

#### Scenario: A released Mac
- **WHEN** a released device calls `GET /v1/agents/policy`
- **THEN** it gets `401 DEVICE_RELEASED` and no `update_package_url`

#### Scenario: A deactivated PC
- **WHEN** a deactivated device calls `GET /v1/agents/policy`
- **THEN** it gets `401 DEVICE_REVOKED` and no `update_package_url`

### Requirement: Admins and IT list the live agent versions
<!-- source: Plan-v3.5 §4.5 "Deployment" · agent-releases -->
`GET /v1/agent-versions` SHALL return, to a `company_admin` or `it_admin`, `{ macos: [...], windows: [...] }`: the distinct versions of non-withdrawn `agent` releases per platform, newest first. A `manager` MUST get `403 FORBIDDEN`.

#### Scenario: Picking the company minimum
- **WHEN** macOS releases 1.3.0 and 1.4.0 are live and 1.5.0 is withdrawn
- **THEN** `macos` is `["1.4.0", "1.3.0"]`
