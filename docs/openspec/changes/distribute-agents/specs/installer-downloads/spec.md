## Purpose

How a company admin or IT admin gets signed, short-lived download links for the Downloader and the
current agent packages, and who cannot.

## ADDED Requirements

### Requirement: Admins and IT get signed download links
<!-- source: Plan-v3.2 §4.4 "Deployment", §4.5 "Deployment" · W31 · D40 -->
`GET /v1/downloads` SHALL return, for a `company_admin` or `it_admin`, the newest non-withdrawn `downloader` release per platform and the newest non-withdrawn `agent` release per platform and architecture, each with `product`, `platform`, `arch`, `version`, `size_bytes`, `sha256`, `url` and `expires_at`.

#### Scenario: IT opens Deployment
- **WHEN** an IT admin calls `GET /v1/downloads`
- **THEN** the list holds the macOS and Windows Downloaders, the macOS universal `.pkg` and the Windows x64 and arm64 MSIs

#### Scenario: A suspended company
- **WHEN** an IT admin of a `suspended` company calls `GET /v1/downloads`
- **THEN** the response is `200` with the links

### Requirement: Download links are short-lived and never logged
<!-- source: Plan-v3.2 §4.4 "Installer distribution" · Plan-v3.2 §5.3 "Secret" -->
Each `url` SHALL be a signed URL to the private `agents` bucket valid for the lifetime in `packages/shared`, and MUST NOT be logged. The bucket MUST NOT be publicly readable.

#### Scenario: A link is reused next week
- **WHEN** a download `url` is opened after it expired
- **THEN** storage refuses it

#### Scenario: A link at its expiry
- **WHEN** a link is opened at its `expires_at`
- **THEN** storage refuses it

### Requirement: Other roles get no links
<!-- source: PRD "Permission matrix" · D41 -->
A `manager` or `super_admin` calling `GET /v1/downloads` SHALL get `403 FORBIDDEN`. A platform or architecture with no live release MUST be left out of the list.

#### Scenario: A manager asks for the installer
- **WHEN** a manager calls `GET /v1/downloads`
- **THEN** the response is `403 FORBIDDEN`

#### Scenario: No live release at all
- **WHEN** every release has been withdrawn
- **THEN** the response is `200` with an empty list
