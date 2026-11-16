## Purpose

What the API writes to its logs for each request, and the secrets and personal content it must
never write.

## ADDED Requirements

### Requirement: Each request is logged once as structured JSON
<!-- source: Plan-v3.5 §3 · B9 -->
The API SHALL write one JSON log line per request with the request ID, method, route pattern, status, `code`, duration, scope and, when known, the company ID and device ID.

#### Scenario: A heartbeat is served
- **WHEN** a heartbeat returns `200`
- **THEN** one log line records the request ID, `POST /v1/agents/heartbeat`, `200`, the duration and the device ID

### Requirement: Secrets are never logged
<!-- source: Plan-v3.5 §5.3 "Secret" · B6 -->
The API MUST NOT log a licence key, enrollment token, device key, uninstall token, invitation token, JWT, cookie, `Authorization` or `X-*-Key` header, signed URL, Stripe secret or webhook signature, at any level, including in error logs.

#### Scenario: Enrollment fails with a bad token
- **WHEN** `POST /v1/devices/enroll` is refused
- **THEN** the log line carries the code but not the token or any prefix of it

### Requirement: Employee content is never logged
<!-- source: D4 · D41 · PRD "Privacy" -->
The API MUST NOT log window titles, URLs, domains, screenshot paths or employee names from any request or response body.

#### Scenario: An activity batch is rejected
- **WHEN** a batch fails validation
- **THEN** the log records the failing field names only, never their values
