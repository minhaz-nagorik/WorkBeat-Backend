## Purpose

The one response shape every client parses: the success and error envelope, the status and code
catalog, and the headers the agents depend on.

## ADDED Requirements

### Requirement: Every response uses the envelope
<!-- source: B9 · agent-contract.md "Status and code catalog" -->
Every JSON response SHALL be `{ "data": … }` on success or `{ "error": "<message>", "code": "<CODE>" }` on failure. The `code` MUST come from the catalog in `packages/shared`. A response with no body MUST be `204` or `304`.

#### Scenario: A route succeeds
- **WHEN** a valid request completes
- **THEN** the body is `{ "data": … }` and carries no `error` field

#### Scenario: A route fails
- **WHEN** a request is refused
- **THEN** the body carries `error` and a catalog `code`
- **AND** the HTTP status matches that code's row in the catalog

### Requirement: Success statuses follow one convention
<!-- source: B9 -->
Unless a route's own spec names another status, a route that creates a record SHALL answer `201` with the created record in `data`, a route that reads, updates or performs an action SHALL answer `200` with the resulting record in `data`, and a route that deletes SHALL answer `204` with no body.

#### Scenario: A company admin adds an employee
- **WHEN** `POST /v1/employees` succeeds
- **THEN** the response is `201` with the new employee in `data`

#### Scenario: A pause is cancelled
- **WHEN** `POST /v1/employees/:id/pauses/:pause_id/cancel` succeeds
- **THEN** the response is `200` with the cancelled pause in `data`

#### Scenario: A route names its own status
- **WHEN** a route's spec says it answers `204`
- **THEN** it answers `204` even though it is an action

### Requirement: Unknown failures are hidden behind INTERNAL
<!-- source: B9 · Plan-v3.5 §8 -->
An unexpected error SHALL return `500` with `code` `INTERNAL` and a generic `error` message. The response MUST NOT contain a stack trace, SQL, a table name or any request value.

#### Scenario: A query fails unexpectedly
- **WHEN** the database raises an error the route does not handle
- **THEN** the response is `500` with `code` `INTERNAL`
- **AND** the body contains no SQL and no stack trace

### Requirement: Invalid input is refused before any write
<!-- source: B9 · Plan-v3 §3 "Backend API" -->
Every request body, query and path parameter SHALL be validated against its `packages/shared` schema before the route runs. A malformed request MUST return `400 VALIDATION_FAILED`, and a well-formed but wrong one `422 VALIDATION_FAILED`, with the failing field names, and MUST write nothing.

#### Scenario: A required field is missing
- **WHEN** a request omits a required field
- **THEN** the response is `400` with `code` `VALIDATION_FAILED` naming that field
- **AND** no row is written

#### Scenario: A field the schema does not know is sent
- **WHEN** a request body carries a field its schema does not define
- **THEN** the field is ignored and never stored

### Requirement: Every response carries a Date header and a request ID
<!-- source: D31 · D36 · agent-contract.md -->
Every response, including errors, SHALL carry a `Date` header from the server clock and an `X-Request-Id` header. When the request sent `X-Request-Id`, the response MUST echo it; otherwise the API MUST generate one.

#### Scenario: An agent sends its request ID
- **WHEN** an agent request carries `X-Request-Id: abc`
- **THEN** the response carries `X-Request-Id: abc` and a `Date` header

### Requirement: Bodies over the limit are refused
<!-- source: agent-contract.md "Status and code catalog" -->
A request body larger than its route's limit in `packages/shared` SHALL be refused with `413 PAYLOAD_TOO_LARGE` before it is parsed.

#### Scenario: An oversized activity batch
- **WHEN** a body exceeds the activity route's limit
- **THEN** the response is `413` with `code` `PAYLOAD_TOO_LARGE`

### Requirement: Lists without a cursor are returned whole
<!-- source: B9 · Plan-v3.5 §4.5 -->
Every list route except `GET /v1/alerts` SHALL return all matching rows in one response, without paging parameters, and MUST stay within the API's time budget for a company of 5,000 employees and 5,000 devices. A list expected to grow past that MUST get a cursor through a spec change first.

#### Scenario: The largest company's devices
- **WHEN** an IT admin of a company with 5,000 devices lists devices
- **THEN** every device is in one `200` response
