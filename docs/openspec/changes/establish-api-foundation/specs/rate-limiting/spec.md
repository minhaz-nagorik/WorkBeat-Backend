## Purpose

Per-credential request limits that protect the API from a misbehaving agent, a brute-forced
licence key or a runaway client, answered in a way every client already handles.

## ADDED Requirements

### Requirement: Limits apply per credential
<!-- source: Plan-v3.5 §6.3 · agent-contract.md -->
The API SHALL limit requests per device key, per licence key, per user and per client IP for unauthenticated routes, with the limits in `packages/shared`. Agent limits MUST allow at least three times the normal cadence of each agent route.

#### Scenario: A healthy agent never hits the limit
- **WHEN** a device sends a heartbeat every 5 minutes, policy every 30 and a batch every 10
- **THEN** none of its requests is refused for rate

### Requirement: Failed credentials are limited per IP
<!-- source: audit 23 Nov 2026 -->
The API SHALL count `401` answers to requests with `X-Device-Key` per client IP and minute. Past the limit in `LIMITS.ratePerIpAuthFailures`, every request with `X-Device-Key` from that IP MUST get `429 RATE_LIMITED` with `Retry-After` until the minute ends. Requests without `X-Device-Key` MUST NOT be counted or refused by this limit.

#### Scenario: Random device keys from one IP
- **WHEN** one IP sends requests with a new random `X-Device-Key` each time
- **THEN** after the limit of `401` answers, its further requests get `429` without a database lookup

#### Scenario: Expired portal sessions behind the web platform
- **WHEN** many portal requests with expired sessions answer `401` in one minute
- **THEN** no portal or agent request is refused for it

### Requirement: Over the limit answers 429 with Retry-After
<!-- source: agent-contract.md "Status and code catalog" -->
A request over its limit SHALL get `429` with `code` `RATE_LIMITED` and a `Retry-After` header in seconds, and MUST NOT be processed.

#### Scenario: A script hammers /license/validate
- **WHEN** one IP exceeds the licence validation limit
- **THEN** further calls get `429 RATE_LIMITED` with `Retry-After`
- **AND** no enrollment token is issued for them
