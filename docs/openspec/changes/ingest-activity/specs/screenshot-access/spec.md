## Purpose

Who can see an employee's screenshots, how a range of days is returned in pages, and how long the signed
URL that shows each image lives.

## ADDED Requirements

### Requirement: The admin and the employee's manager see a range of days
<!-- source: PRD "Permission matrix" · PRD "Screenshots" · Plan-v3.5 §4.4 "Reports and data lifecycle" · B19 -->
`GET /v1/employees/:id/screenshots?from=&to=` SHALL return, for a `company_admin` or the employee's manager, the employee's `uploaded` screenshots captured from `from` through `to` in the company's `timezone`, newest first, each with `id`, `captured_at`, `device_id`, the device's `hostname`, `view_url`, `download_url` and `expires_at`. `pending` screenshots MUST NOT be listed.

#### Scenario: A manager opens their report's screenshots
- **WHEN** a manager requests a range for an employee on their team
- **THEN** that range's uploaded screenshots are returned newest first with signed view URLs

#### Scenario: A device changed hands by release
- **WHEN** a device bound to employee A was released at noon and set up again for employee B
- **THEN** A's timeline for that day holds only screenshots with `employee_id` A and B's only those with `employee_id` B

#### Scenario: An archived employee
- **WHEN** a company admin opens a day for an archived employee
- **THEN** that day's uploaded screenshots are returned

#### Scenario: A day with only pending screenshots
- **WHEN** every screenshot of the day is still `pending`
- **THEN** the response has an empty list and issues no signed URL

### Requirement: A tile can load a thumbnail
<!-- source: product owner 19 Nov 2026 · screenshot-upload "A screenshot may come with a thumbnail" -->
Each item's `thumb_url` SHALL be a signed URL to the screenshot's thumbnail when the confirmed row has one, and null otherwise; `view_url` MUST always be the full image.

#### Scenario: A screenshot from an agent without thumbnails
- **WHEN** a listed screenshot was uploaded without a thumbnail
- **THEN** its `thumb_url` is null and its `view_url` is set

### Requirement: View URLs are short-lived
<!-- source: PRD "Screenshots" · PRD "Risks" -->
Each `view_url`, `thumb_url` and `download_url` SHALL be a signed URL valid for 5 minutes (value from `packages/shared`) and MUST NOT be logged.

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
While the company's `screenshot_tier` is `off`, the route SHALL return `screenshots_enabled` false, no items, `total` 0 and `next_cursor` null, and MUST issue no signed URL. Otherwise it MUST return `screenshots_enabled` true.

#### Scenario: The add-on was cancelled
- **WHEN** a company with stored screenshots moves to tier `off`
- **THEN** the timeline returns `screenshots_enabled` false and an empty list

#### Scenario: The add-on is restored
- **WHEN** the tier moves from `off` back to `standard`
- **THEN** screenshots stored before are listed again with `screenshots_enabled` true

### Requirement: The range names company days
<!-- source: B19 · PRD "Screenshots" -->
`from` and `to` SHALL be inclusive `YYYY-MM-DD` dates naming [`from` 00:00, the day after `to` 00:00) in `companies.timezone`, matched on `captured_at`. `date=D` MUST mean `from=D&to=D`. A missing, malformed or impossible date, `to` before `from`, or a range over 90 days MUST return `422 VALIDATION_FAILED` and issue no signed URL.

#### Scenario: Either side of local midnight
- **WHEN** a company in `Asia/Dhaka` has screenshots at 23:59 and 00:00 local time
- **THEN** a request for the first date lists only the 23:59 one and a request for the next date only the 00:00 one

#### Scenario: An impossible date
- **WHEN** an admin requests `date=2026-02-30`
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

#### Scenario: A reversed range
- **WHEN** an admin requests `from=2026-11-18&to=2026-11-17`
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

### Requirement: The range can be limited to hours of each day
<!-- source: product owner 19 Nov 2026 -->
`start` and `end` SHALL be optional `HH:MM` times in `companies.timezone` that keep only screenshots whose `captured_at` time of day is in [`start`, `end`) on every day of the range; `total` and paging MUST count only those. Neither means the whole day. One without the other, a malformed time, `start` of `24:00`, an `end` past `24:00` or an `end` not after `start` MUST return `422 VALIDATION_FAILED` and issue no signed URL.

#### Scenario: Mornings of a week
- **WHEN** an admin requests seven days with `start=09:00&end=12:00`
- **THEN** only screenshots taken from 09:00 up to but not including 12:00 company time on each of those days are listed, and `total` counts only them

#### Scenario: The whole day as hours
- **WHEN** an admin requests `start=00:00&end=24:00`
- **THEN** the response lists the same screenshots as without `start` and `end`

#### Scenario: Hours across midnight
- **WHEN** an admin requests `start=22:00&end=02:00`
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

### Requirement: The range stops at retention
<!-- source: Plan-v3.5 §4.4 "Reports and data lifecycle" · usage-reports -->
A `from` before the first retained day (today minus `data_retention_days` plus one, company time) SHALL be moved to that day. The response MUST return the `from` and `to` it used.

#### Scenario: A range reaching past retention
- **WHEN** retention is 30 days and an admin asks from 60 days ago to today
- **THEN** the response `from` is 29 days ago and no older screenshot is listed

### Requirement: The range comes back in pages
<!-- source: WorkBeat Admin request (18 Nov 2026) · alerts feed paging -->
The route SHALL return at most `limit` items (1–60, default 24) and `next_cursor`, an opaque string for the next page or `null` on the last. `cursor` MUST continue strictly after the last item returned, newest first, with ties on `captured_at` ordered by `id`. A `limit` out of range or a malformed `cursor` MUST return `422 VALIDATION_FAILED`.

#### Scenario: Paging through a range
- **WHEN** a range holds 50 screenshots and pages of 24 are read by following `next_cursor`
- **THEN** the pages hold 24, 24 and 2 items, none twice, and the last page's `next_cursor` is `null`

#### Scenario: A bad limit
- **WHEN** an admin requests `limit=0` or `limit=61`
- **THEN** the response is `422` with `code` `VALIDATION_FAILED`

### Requirement: Every page carries the range total
<!-- source: WorkBeat Admin request (18 Nov 2026) -->
Every response SHALL include `total`, the number of `uploaded` screenshots in the whole range regardless of `cursor` and `limit`. Signed URLs MUST be issued only for the items of the page returned.

#### Scenario: A later page
- **WHEN** an admin reads the second page of a 50-screenshot range
- **THEN** `total` is 50 and 24 items carry signed URLs
