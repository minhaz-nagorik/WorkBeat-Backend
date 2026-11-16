## Purpose

How an agent stores one screenshot: a pending row and a short-lived signed upload URL into private
storage, then a confirmation the API checks before the image counts as uploaded.

## ADDED Requirements

### Requirement: An upload request returns a signed URL for a pending screenshot
<!-- source: D23 · D13 · PRD "Screenshots" · capture-screenshots/screenshot-capture -->
`POST /v1/agents/screenshots` with `id`, `captured_at` and `bytes`, and `Idempotency-Key` = `id`, SHALL insert a `screenshots` row with `status` `pending` and `storage_path` `{company_id}/{device_id}/{id}.jpg`, and return `201` with `id`, `status`, `upload_url` (a signed upload URL to the private `screenshots` bucket) and its `expires_at`. The URL lifetime MUST come from `packages/shared`.

#### Scenario: A capture is queued for upload
- **WHEN** an agent requests an upload for a new screenshot ID
- **THEN** a pending row exists and the response carries a signed `upload_url`

#### Scenario: Two upload requests for one ID at once
- **WHEN** the same screenshot request is sent twice concurrently
- **THEN** one `screenshots` row exists
- **AND** one response is `201` and the other `200`, both with `status` `pending`

### Requirement: A repeated request returns the current state
<!-- source: D13 · agent-contract.md "Status and code catalog" -->
A repeat for a known `id` of the same device SHALL return `200`: a fresh `upload_url` while `pending`, or `status` `uploaded` with `upload_url` null. A known `id` with a different `captured_at` or `bytes`, or one held by another device, MUST get `409 IDEMPOTENCY_KEY_REUSED`.

#### Scenario: The signed URL expired before the upload
- **WHEN** the agent asks again for a pending screenshot
- **THEN** the response is `200` with a new `upload_url`
- **AND** no second row is written

#### Scenario: A repeat after confirmation
- **WHEN** the agent requests an upload for a screenshot already `uploaded`
- **THEN** the response is `200` with `status` `uploaded` and `upload_url` null

#### Scenario: Another device sends the same ID
- **WHEN** a device of the same or another company requests an upload with an `id` another device holds
- **THEN** the response is `409 IDEMPOTENCY_KEY_REUSED`
- **AND** the existing row is unchanged and no storage path of the other device is returned

#### Scenario: A repeat with a different size
- **WHEN** a known pending `id` arrives with a different `bytes`
- **THEN** the response is `409 IDEMPOTENCY_KEY_REUSED`

### Requirement: Confirmation checks the stored object
<!-- source: PRD "Screenshots" · capture-screenshots/screenshot-capture -->
`POST /v1/agents/screenshots/:id/confirm` SHALL set `status` `uploaded` and `uploaded_at` only when the object exists at `storage_path` with a size equal to `bytes`, and return `200` with `id` and `status`. A missing or mis-sized object MUST get `422 VALIDATION_FAILED` and leave the row `pending`; a mis-sized object MUST be deleted. An unknown `id` MUST get `404 NOT_FOUND`.

#### Scenario: The upload never reached storage
- **WHEN** an agent confirms a screenshot whose object does not exist
- **THEN** the response is `422 VALIDATION_FAILED`
- **AND** the row stays `pending`

#### Scenario: A confirmation is repeated
- **WHEN** an uploaded screenshot is confirmed again
- **THEN** the response is `200` with `status` `uploaded`
- **AND** `uploaded_at` keeps its first value

#### Scenario: Confirmed before the PUT
- **WHEN** an agent confirms right after the upload request, before putting the image
- **THEN** the response is `422 VALIDATION_FAILED` and the row stays `pending`
- **AND** a confirm after the PUT completes returns `200` with `status` `uploaded`

#### Scenario: Two confirmations at once
- **WHEN** one screenshot is confirmed twice concurrently after a correct upload
- **THEN** both responses are `200` with `status` `uploaded` and `uploaded_at` is set once

#### Scenario: A mis-sized upload is retried
- **WHEN** a confirm found a mis-sized object and the agent requests the upload again
- **THEN** the response is `200` with a new `upload_url` for the same `storage_path`
- **AND** a correct upload then confirms `200`

#### Scenario: Another device confirms the ID
- **WHEN** a device confirms a screenshot `id` held by another device
- **THEN** the response is `404 NOT_FOUND` and the row is unchanged

### Requirement: Only JPEGs within the size limit are accepted
<!-- source: D23 · PRD "Screenshots" -->
The `screenshots` bucket SHALL accept only `image/jpeg` objects up to the size limit in `packages/shared`, and an upload request whose `bytes` exceeds that limit, or whose `captured_at` is outside [now − 8 days, now + 1 day] (B7), MUST get `422 VALIDATION_FAILED` and write nothing.

#### Scenario: An oversized capture
- **WHEN** an upload request declares `bytes` above the limit
- **THEN** the response is `422 VALIDATION_FAILED`

#### Scenario: Exactly the limit
- **WHEN** an upload request declares `bytes` equal to the limit
- **THEN** it is accepted with `201`

#### Scenario: A capture older than the window
- **WHEN** an upload request carries `captured_at` 9 days ago
- **THEN** the response is `422 VALIDATION_FAILED` and no row is written

### Requirement: A screenshot is accepted whatever the current setting
<!-- source: D37 · PRD "Screenshots" · Plan-v3.5 §2.2 -->
The API SHALL accept a valid screenshot even when the employee's `screenshot_interval_seconds` is 0 or the company's `screenshot_tier` is `off` at receipt, because the agent follows a policy up to 30 minutes old.

#### Scenario: Screenshots were switched off ten minutes ago
- **WHEN** a screenshot captured before the change arrives after it
- **THEN** it is accepted and stored

#### Scenario: Captured during a suspension, sent after it
- **WHEN** a screenshot request got `402 COMPANY_SUSPENDED` and is sent again after the company is restored
- **THEN** the second request is answered `201` as the first sight

### Requirement: Storage paths and signed URLs stay private
<!-- source: Plan-v3.5 §5.3 "Secret" · PRD "Tenant isolation" -->
The `screenshots` bucket SHALL be private, every object MUST sit under its company's prefix, and no signed URL or storage path MUST be logged.

#### Scenario: An upload is logged
- **WHEN** an upload request is served
- **THEN** its log line carries neither `upload_url` nor `storage_path`

### Requirement: A screenshot belongs to the binding that requested its upload
<!-- source: D44 · D45 · D48 · Plan-v3.5 §6.1 · Plan-v3.5 §4.4 "Binding history" · data-model.md "Ingested data" -->
The `screenshots` row SHALL take `company_id`, `device_id` and `employee_id` from the binding of the device key when it is first written, never from the body, and no later event MUST change them.

#### Scenario: Released between request and confirm
- **WHEN** a device of employee A requests an upload, is released, and confirms with its released key inside the 7-day window
- **THEN** the screenshot is `uploaded` with the released binding's `device_id` and `employee_id` A

#### Scenario: A body names another employee
- **WHEN** an upload request carries an `employee_id` other than the device's
- **THEN** the row is written with the device's `employee_id`
