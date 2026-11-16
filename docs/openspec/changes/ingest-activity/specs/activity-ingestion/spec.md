## Purpose

How `POST /v1/agents/activity` turns one sealed agent batch into rows exactly once, which records it
keeps, and how it answers a repeat, a reused key and a malformed batch.

## ADDED Requirements

### Requirement: A batch is written once, in one transaction
<!-- source: D13 · Plan-v3.5 §2.2, §4.4 "Ingestion and device health" · buffer-and-sync/activity-sync -->
On the first sight of a `batch_id` for a device, the API SHALL insert the `ingest_batches` row and every accepted record in one transaction and return `200` with `batch_id`, the accepted count per array and `dropped_out_of_window`. Any failure MUST write nothing. `Idempotency-Key` MUST equal `batch_id`, or the request gets `400 VALIDATION_FAILED`.

#### Scenario: The response is lost and the batch is resent
- **WHEN** a committed batch is sent again with the same `Idempotency-Key` and body
- **THEN** the response is `200` with the counts of the first answer
- **AND** no record is written a second time

#### Scenario: Two copies arrive at once
- **WHEN** the same batch is posted twice concurrently
- **THEN** its records are stored once and both responses carry the same counts

#### Scenario: The first attempt failed with a 5xx
- **WHEN** a batch got `500 INTERNAL` and the agent resends it with the same `Idempotency-Key`
- **THEN** the retry is treated as the first sight, because the failed attempt wrote nothing
- **AND** its records are stored once

#### Scenario: No Idempotency-Key
- **WHEN** a batch arrives without an `Idempotency-Key` header, or with one that differs from `batch_id`
- **THEN** the response is `400` with `code` `VALIDATION_FAILED` and nothing is written

### Requirement: A reused key with a different body is refused
<!-- source: D13 · agent-contract.md "Status and code catalog" -->
The API SHALL store the SHA-256 of each accepted batch body with its `ingest_batches` row. A later request with the same device and `batch_id` and a different body hash MUST get `409 IDEMPOTENCY_KEY_REUSED` and write nothing.

#### Scenario: A batch is altered after sealing
- **WHEN** a known `batch_id` arrives with one more app session
- **THEN** the response is `409 IDEMPOTENCY_KEY_REUSED`
- **AND** the records of the first body stay as they were

#### Scenario: Two devices use the same batch_id
- **WHEN** a device sends a `batch_id` that another device, of the same or another company, already used
- **THEN** it is accepted as that device's own first batch with `200`
- **AND** the other device's batch and counts are untouched

### Requirement: Records are stamped from the credential
<!-- source: Plan-v3.5 §6.1 · D44 · D48 · B2 · Plan-v3.5 §4.4 "Binding history" · data-model.md "Ingested data" -->
Every stored record SHALL carry the `company_id`, `device_id` and `employee_id` of the binding whose device key uploaded it, never from the body and never re-credited by timestamp, and the record's `batch_id` where its table has one. The agent's `session_user` MUST be stored as `os_user`, and Unix-millisecond times MUST be stored as `timestamptz`.

#### Scenario: A released binding uploads its buffer
- **WHEN** a device bound to employee A is released, enrolled again for employee B, and A's released key uploads a batch inside its 7-day window
- **THEN** the batch's records carry the released binding's `device_id` and employee A, never B's binding

#### Scenario: A device clock is skewed
- **WHEN** a batch's records carry times from before the binding's `enrolled_at`
- **THEN** they are still stored under the uploading binding and its employee

#### Scenario: A body names another company
- **WHEN** a batch's records carry `company_id`, `device_id` or `employee_id` of another company
- **THEN** those fields are ignored and every record is stored for the key's device

### Requirement: Records outside the time window are dropped and counted
<!-- source: B7 · D7 -->
A record whose `started_at`, `visited_at` or `bucket_start` is before server now − 8 days or after server now + 1 day SHALL be dropped and counted in `dropped_out_of_window`; the rest of the batch MUST still be stored and answered with `200`.

#### Scenario: A clock was a week fast
- **WHEN** a batch holds 10 sessions, 2 of them dated 6 days ahead
- **THEN** 8 sessions are stored and `dropped_out_of_window` is 2

#### Scenario: A record exactly on the window edge
- **WHEN** a bucket's `bucket_start` equals server now − 8 days
- **THEN** it is stored and not counted in `dropped_out_of_window`

#### Scenario: Every record is outside the window
- **WHEN** a batch holds 5 sessions all dated 9 days ago
- **THEN** the response is `200` with every accepted count 0 and `dropped_out_of_window` 5
- **AND** the `ingest_batches` row is written, so a repeat gets the same answer

#### Scenario: A batch resent after its idempotency row was cleaned up
- **WHEN** a batch sealed 15 days ago is sent again after its `ingest_batches` row was removed
- **THEN** it is answered `200` as a first sight and every record is counted in `dropped_out_of_window`

### Requirement: Empty arrays are accepted and buckets are upserted
<!-- source: D37 · agent-contract.md "Payload fields" -->
Each of `app_sessions`, `url_visits`, `activity_buckets` and `idle_intervals` SHALL be accepted when empty. An activity bucket with a `(device_id, bucket_start)` already stored MUST replace that row's samples rather than fail the batch.

#### Scenario: Website visits are switched off
- **WHEN** a batch carries an empty `url_visits` array
- **THEN** it is accepted with a `url_visits` count of 0

#### Scenario: Every array is empty
- **WHEN** a batch carries four empty arrays
- **THEN** the response is `200` with every count 0 and `dropped_out_of_window` 0
- **AND** the `ingest_batches` row is written

#### Scenario: A bucket sent again in a later batch
- **WHEN** a later batch carries a bucket whose `(device_id, bucket_start)` is already stored
- **THEN** the stored row takes the later `active_samples` and `total_samples`
- **AND** the batch is answered `200`

### Requirement: A malformed batch is refused whole
<!-- source: B9 · buffer-and-sync/activity-sync · agent-contract.md "Status and code catalog" -->
A batch with a record that fails its schema (`duration_seconds` < 0, `active_samples` > `total_samples`, `ended_at` < `started_at`, a missing `url` or `domain`) SHALL get `400` or `422 VALIDATION_FAILED` and MUST write nothing. An empty `window_title` MUST be valid.

#### Scenario: A session ends before it starts
- **WHEN** one app session has `ended_at` before `started_at`
- **THEN** the response is `422 VALIDATION_FAILED`
- **AND** no record of the batch is stored

#### Scenario: Active samples on the limit
- **WHEN** a bucket has `active_samples` equal to `total_samples`
- **THEN** it is valid and stored

#### Scenario: A zero-length session
- **WHEN** an app session has `duration_seconds` 0 and `ended_at` equal to `started_at`
- **THEN** it is valid and stored

### Requirement: Stored content is what the agent filtered
<!-- source: D4 · D37 · report-device-health/monitoring-features -->
The API SHALL store records as sent; sensitive-domain and feature-switch filtering is done on the agent, and the API MUST NOT add a URL, title or record the agent did not send.

#### Scenario: A title withheld by the agent
- **WHEN** an app session arrives with `window_title` ''
- **THEN** it is stored with `window_title` ''

#### Scenario: A record timed inside a monitoring pause
- **WHEN** an app session whose `started_at` falls inside the employee's pause arrives
- **THEN** it is stored as sent, because the agent applies pauses from a policy up to 30 minutes old

### Requirement: A bucket repeated within one batch is stored once
<!-- source: D13 · D37 · B7 · buffer-and-sync/activity-sync -->
When one batch carries two or more `activity_buckets` rows with the same `bucket_start`, the API SHALL store only the last of them in array order, count it once in the `activity_buckets` count and MUST NOT refuse the batch, so a duplicate never quarantines a whole batch.

#### Scenario: The same bucket twice in a batch
- **WHEN** a batch carries two buckets for 10:05, the first with 3 active samples and the second with 5
- **THEN** one row for 10:05 is stored with 5 active samples
- **AND** the response's `activity_buckets` count is 1

### Requirement: A batch refused by the device guard leaves no trace
<!-- source: D5 · D13 · D45 · enroll-devices/device-authentication · buffer-and-sync/activity-sync · Plan-v3.5 §4.4 "Device release" -->
A batch answered `401` or `402` by `device-authentication` SHALL write no `ingest_batches` row and no record, so the same batch sent after the company is restored MUST be accepted as a first sight.

#### Scenario: Sent during a suspension, resent after it
- **WHEN** a batch got `402 COMPANY_SUSPENDED` and is sent again after the company returns to `active`
- **THEN** the second answer is `200` and its records are stored once

#### Scenario: A released device uploads after its window
- **WHEN** a device released more than 7 days ago posts a batch
- **THEN** the response is `401 DEVICE_RELEASED` and no row is written
