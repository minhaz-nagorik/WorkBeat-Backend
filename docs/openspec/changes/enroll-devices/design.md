## Context

The agent repositories were written before Plan v3.5 D43 to D48. They still describe portal-made
enrollment tokens (`wbe_…` entered in the Downloader, `ENROLLMENT_TOKEN_REVOKED`), an optional
`employee_id` with an *Unassigned* option and an unassigned queue, and a `/license/validate` that
returns a token in one call. Plan v3.5 is the source of truth (config.yaml "Source authority"); the
backend follows it and the agent repositories are behind.

## Decisions

### 1. The employee is required and comes from the token (amends Mac `enroll-device` "Enrollment sends a stable device identity", `downloader` "IT confirms the company and picks the employee", "A silent mode supports scripted installs")

The enrollment token is issued only for an `employee_id` (B8) and stores it
(`enrollment_tokens.employee_id NOT NULL`). `POST /v1/devices/enroll` binds the device to the
token's employee for the binding's life (D48). An `employee_id` in the body is accepted only when it equals the token's;
otherwise `422 VALIDATION_FAILED`. There is no unassigned queue and no *Unassigned* path: a
Downloader that offers one gets no token without an `employee_id`.

**Why the newer rule wins:** D47 — every device is installed for a picked employee, the seat is
filled at enrollment for that employee. Taking the employee from the token means a tampered
config file cannot move a device to someone else.

### 2. No portal tokens (amends Mac `downloader` "The Downloader accepts a token or a license key", agent `ENROLLMENT_TOKEN_REVOKED`)

`/license/validate` accepts only `X-License-Key`. No route creates, lists or revokes an
enrollment token. A licence-key reissue deletes unused tokens (`administer-platform`), which then
answer `404 ENROLLMENT_TOKEN_INVALID`; `ENROLLMENT_TOKEN_REVOKED` is never returned.

**Why the newer rule wins:** D43 — the licence key is the only install credential; a token is
internal, single-use, and seen by no person.

### 3. Validation has two steps and reserves nothing (amends agent-side single-call validate, applies B8)

Step 1 (no `employee_id`) returns `company_name` and the active employee list for the searchable
picker (D42). Step 2 (`employee_id`) also returns the token. Both check suspension, expiry and a
free seat, and neither holds a seat: the seat is taken by `devices_seat` at enrollment. Extra
fields the Downloader sends today (`hostname`, `os_version`, `hardware_id`) are ignored.

**Why:** B8, D47 and Plan-v3.5 §5.3 step 6 — "checking the key in the Downloader reserves nothing,
and a failed install takes no seat". Two devices may therefore both pass validation for the last
seat; the second enrollment gets `403 SEAT_LIMIT_EXCEEDED`, which the agent already retries.

### 4. There is no deactivate (B35)

No route ends a binding except `POST /v1/devices/:id/release` from a portal user. The uninstaller
calls nothing; an uninstalled computer keeps its seat, shows `offline`, and an admin releases it.

**Why:** product owner, 23 Nov 2026. One way to end a binding; deactivate's "keep blocking but stop
collecting" state was confusing next to a monitoring pause.

## Risks

- A token's employee archived between validation and enrollment: enrollment answers
  `404 EMPLOYEE_NOT_FOUND` (agent-contract.md catalog), which the agent handles as a failed
  enrollment.
- `auth_enrollment_token` returns `used` and `expired` (`0002_spec_gaps.sql`), which is enough to
  tell `ENROLLMENT_TOKEN_EXHAUSTED` from `ENROLLMENT_TOKEN_EXPIRED` without a tenant-scope read.
