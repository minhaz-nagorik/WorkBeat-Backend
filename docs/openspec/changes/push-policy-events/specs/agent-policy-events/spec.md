## Purpose

`GET /v1/agents/events`: a Server-Sent Events stream that hands each connected device its whole
policy when the stream opens and again within seconds of any change to it.

## ADDED Requirements

### Requirement: The stream opens with the current policy
<!-- source: B32 · agent-contract.md "Policy events" · Mac stream-policy-events "policy-events" -->
`GET /v1/agents/events`, authenticated like `GET /v1/agents/policy`, SHALL answer `200` with `Content-Type: text/event-stream`, `Cache-Control: no-cache` and `X-Accel-Buffering: no`, then send one `policy` event. Its `data` MUST be one line of JSON, `{ "etag": <the ETag GET /v1/agents/policy would send>, "data": <that same body> }`.

#### Scenario: An enrolled device connects
- **WHEN** an enrolled device opens the stream
- **THEN** the first event is `policy` with the body and ETag `GET /v1/agents/policy` returns at that moment

#### Scenario: A suspended company's device connects
- **WHEN** a device of a suspended company opens the stream
- **THEN** the answer is `402 COMPANY_SUSPENDED` and no stream is held

#### Scenario: An unknown key
- **WHEN** the stream is opened with a revoked key
- **THEN** the answer is `401 DEVICE_REVOKED`

### Requirement: A changed policy is pushed within seconds
<!-- source: B32 · B5 · B30 -->
After a transaction commits that raises the `policy_version` of a company or of an employee's settings, the API SHALL send a fresh `policy` event to every open stream of the affected devices, each after its own random delay of 0–5 seconds. A device with a push already waiting MUST NOT get a second one for the same change.

#### Scenario: IT adds a block rule
- **WHEN** a block rule is added to a company with three connected devices
- **THEN** each of the three streams receives the new policy within 5 seconds
- **AND** no device of another company receives anything

#### Scenario: A pause for one employee
- **WHEN** a pause is added for one employee
- **THEN** only that employee's devices receive a new policy

#### Scenario: A rolled-back change
- **WHEN** a transaction that changed a block rule is rolled back
- **THEN** no event is sent

#### Scenario: Two hundred rules imported at once
- **WHEN** one transaction inserts 200 block rules
- **THEN** each connected device of that company receives one new policy, not 200

### Requirement: Streams stay alive and close on loss of access
<!-- source: B32 · B21 · D6 -->
Every open stream SHALL receive a comment line at least every 25 seconds. A device holds at most one stream: a new one MUST close the older. A stream SHALL be closed when its device is released or revoked, and when a push would answer `401` or `402`.

#### Scenario: An idle stream
- **WHEN** no policy changes for a minute
- **THEN** the stream has received at least two comment lines

#### Scenario: The device is released
- **WHEN** an admin releases a device with an open stream
- **THEN** its stream is closed
- **AND** the agent's reopen is answered `401 DEVICE_RELEASED`

#### Scenario: The same device connects twice
- **WHEN** a device opens a second stream
- **THEN** the first is closed and only the second receives events
