## Purpose

Who can see an employee's screenshots, how a day's timeline is returned, and how long the signed
URL that shows each image lives.

## ADDED Requirements

### Requirement: The admin and the employee's manager see a day's timeline
<!-- source: PRD "Permission matrix" · PRD "Screenshots" · Plan-v3.5 §4.4 "Reports and data lifecycle" -->
`GET /v1/employees/:id/screenshots?date=YYYY-MM-DD` SHALL return, for a `company_admin` or the employee's manager, the employee's `uploaded` screenshots captured on that day in the company's `timezone`, oldest first, each with `id`, `captured_at`, `device_id`, the device's `hostname`, `view_url`, `download_url` and `expires_at`. `pending` screenshots MUST NOT be listed.

#### Scenario: A manager opens their report's screenshots
- **WHEN** a manager requests a day for an employee on their team
- **THEN** that day's uploaded screenshots are returned with signed view URLs

#### Scenario: A device changed hands by release
- **WHEN** a device bound to employee A was released at noon and set up again for employee B
- **THEN** A's timeline for that day holds only screenshots with `employee_id` A and B's only those with `employee_id` B

#### Scenario: An archived employee
- **WHEN** a company admin opens a day for an archived employee
- **THEN** that day's uploaded screenshots are returned

#### Scenario: A day with only pending screenshots
- **WHEN** every screenshot of the day is still `pending`
- **THEN** the response has an empty list and issues no signed URL

### Requirement: View URLs are short-lived
<!-- source: PRD "Screenshots" · PRD "Risks" -->
Each `view_url` and `download_url` SHALL be a signed URL valid for 5 minutes (value from `packages/shared`) and MUST NOT be logged.

#### Scenario: A link is shared later
- **WHEN** a `view_url` is opened 10 minutes after the response
- **THEN** storage refuses it

#### Scenario: A link at its expiry
- **WHEN** a response is returned
- **THEN** each item's `expires_at` is 5 minutes after the signing time

### Requirement: Every screenshot can be saved as a file
<!-- source: WorkBeat Admin backend requests round 7 (17 Nov 2026) -->
Screenshots SHALL be stored only in Cloudflare R2. Each item's `download_url` SHALL be an R2 presigned URL for the same object and expiry as its `view_url`, with `response-content-disposition=attachment; filename="<hostname>-<YYYY-MM-DD>-<HHMM>.jpg"` (capture time in the company's `timezone`; characters outside `A-Z a-z 0-9 . _ -` in the hostname become `-`) and `response-content-type=image/jpeg` inside the signature.

#### Scenario: An admin saves a screenshot
- **WHEN** a screenshot of `NG-LT-0141` captured at 09:30 on 17 Nov 2026 company time is downloaded
- **THEN** storage answers `Content-Disposition: attachment; filename="NG-LT-0141-2026-11-17-0930.jpg"`

#### Scenario: The file name is changed in the link
- **WHEN** the `response-content-disposition` value of a `download_url` is edited
- **THEN** storage refuses the link

### Requirement: Other roles never see screenshots
<!-- source: PRD "Permission matrix" · D41 -->
An `it_admin` and a `super_admin` SHALL get `403 FORBIDDEN`. A manager asking for an employee who is not on their team, or anyone asking for another company's employee, MUST get `404 NOT_FOUND`.

#### Scenario: IT asks for screenshots
- **WHEN** an IT admin calls the route
- **THEN** the response is `403 FORBIDDEN`

#### Scenario: A former manager
- **WHEN** an employee moved to another manager and the former manager requests their screenshots
- **THEN** the response is `404 NOT_FOUND`

#### Scenario: A company admin asks for another company's employee
- **WHEN** the employee ID belongs to another company
- **THEN** the response is `404 NOT_FOUND`
- **AND** no signed URL is issued

### Requirement: The timeline is hidden while the tier is off
<!-- source: PRD "Screenshots" · PRD "Pricing" -->
While the company's `screenshot_tier` is `off`, the route SHALL return `screenshots_enabled` false and no items, and MUST issue no signed URL. Otherwise it MUST return `screenshots_enabled` true.

#### Scenario: The add-on was cancelled
- **WHEN** a company with stored screenshots moves to tier `off`
- **THEN** the timeline returns `screenshots_enabled` false and an empty list

#### Scenario: The add-on is restored
- **WHEN** the tier moves from `off` back to `standard`
- **THEN** screenshots stored before are listed again with `screenshots_enabled` true

### Requirement: The date names one company day
<!-- source: B19 · PRD "Screenshots" -->
`date` SHALL be a `YYYY-MM-DD` calendar date naming [00:00, next 00:00) in `companies.timezone`, matched on `captured_at`. A missing, malformed or impossible `date` MUST return `400 VALIDATION_FAILED` and issue no signed URL.

#### Scenario: Either side of local midnight
- **WHEN** a company in `Asia/Dhaka` has screenshots at 23:59 and 00:00 local time
- **THEN** the 23:59 one is listed under the first date and the 00:00 one under the next

#### Scenario: An impossible date
- **WHEN** an admin requests `date=2026-02-30`
- **THEN** the response is `400` with `code` `VALIDATION_FAILED`
