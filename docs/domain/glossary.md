# Glossary

Backend words, one line each. Use them exactly. D-numbers are WorkBeat Plan v3.5 rulings; B-numbers
are [backend decisions](../decisions/backend-decisions.md). The schema is
[`db/migrations/`](../../db/migrations/); requirements are in
[`docs/openspec/changes/`](../openspec/changes/).

## Secrets

| Term | Meaning | Avoid |
|---|---|---|
| **Licence key** | `WB-XXXX-XXXX-XXXX-XXXX`, one per company, the only install credential. Stored as `key_hash`, `key_ciphertext`, `key_last4` (D43, B6) | "activation key", "install token" |
| **Enrollment token** | Internal, single-use, 24-hour secret issued by `/license/validate` step 2, bound to one employee. No person sees it (D26, D43, B8) | "portal token", `wbe_` token from the portal (gone since D43) |
| **Device key** | One per device, returned once by `POST /v1/devices/enroll`, sent as `X-Device-Key`, stored only as `devices.key_hash` (D3) | "API key", "token" |
| **Uninstall token** | Per-company secret IT reads in the portal; policy carries only its hash (D19, B6) | "admin password" |
| **Cron secret** | `X-Cron-Secret`, the only credential `/cron/*` routes accept (B10) | — |

## Company and billing

| Term | Meaning | Avoid |
|---|---|---|
| **Company** | One customer, one `companies` row, one `licenses` row | "tenant" in prose for users (fine in code) |
| **Status** | `trial`, `active`, `suspended`, `expired` (B14). Changed only by Stripe events and staff | — |
| **Suspended reason** | `payment_failed` (D29) or `staff`. Set exactly when status is `suspended` | — |
| **Expired** | Stripe subscription deleted; `licenses.expired_at` set (D30) | "cancelled" as a status |
| **Grace days** | `companies.expired_blocking_grace_days`, default 30, staff-editable (D36) | — |
| **`blocking_ends_at`** | `expired_at` + grace days. Computed on read, never stored (D36) | — |
| **Ended** | Agent-side state: company `expired` and now past `blocking_ends_at`. Not a backend status | Using it as a `companies.status` value |
| **Plan** | `starter` (10 seats), `growth` (50), `enterprise` (staff-set or unlimited) | — |
| **Tier** | `licenses.screenshot_tier`: `off`, `light` (3600 s), `standard` (1800 s), `intensive` (600 s) | "screenshot plan" |
| **Trial** | Starter companies start `trial` for 14 days (`trial_ends_at`, B14) | — |

## Seats and devices

| Term | Meaning | Avoid |
|---|---|---|
| **Seat** | Held by every device with `deactivated_at` and `released_at` both NULL. Counted, never stored (D43, B4) | "licence" for a seat |
| **Seats used** | `count(devices)` of the company that hold a seat, on every read | A stored counter |
| **Seat limit** | `licenses.seat_limit`; NULL is unlimited. Enforced by trigger `devices_seat` | — |
| **Validate** | `POST /v1/license/validate`. Step 1: company and employees. Step 2: also the token. Reserves nothing (B8) | "activate" |
| **Enroll** | `POST /v1/devices/enroll`: token → device key. Makes a new binding (seat taken) or re-keys the same one; another employee's live binding answers `409 DEVICE_ASSIGNED` (D2, D48) | — |
| **Hardware ID** | The device ID the agent produces (format open, Q10). A live binding with the same ID and employee is reused (D2) | "serial" |
| **Deactivate** | Sets `deactivated_at`, clears `key_hash`, frees the seat. Next call: `401 DEVICE_REVOKED` (D6) | "release" |
| **Release** | Sets `released_at`, keeps `key_hash`, frees the seat. Ends the binding. Next call: `401 DEVICE_RELEASED`; the agent uploads with the released key for up to 24 h (accepted 7 days), then wipes and goes dormant. The row is final (D38, D45) | "deactivate", "unenroll" |
| **Binding** | One `devices` row: device ID + company licence + employee. Its employee never changes; a device goes to someone else by release and a new WorkBeat Setup (D48, B20) | "assignment" (there is no reassign), "unassign" |
| **Reissue** | Staff replace the licence key on the same row; unused tokens deleted; seats unchanged (D43) | "reset seats" |
| **Archive** | "Remove" an employee: `archived_at` set. Refused while any binding of the employee is not released, deactivated or not (D46, 0003) | "delete employee" |

## Policy

| Term | Meaning | Avoid |
|---|---|---|
| **Policy** | The body of `GET /v1/agents/policy`, resolved for one device (D8) | "config" |
| **Policy version** | `greatest(company, employee settings, device)` values from one sequence `policy_version_seq`. Only grows (B5) | "policy revision" |
| **ETag** | Hash of the resolved policy body; a match answers `304` (D8) | — |
| **Monitoring settings** | Per-employee switches `activity`, `app_usage`, `window_titles`, `website_visits` and the screenshot interval (D37) | "company policy" for these |
| **Tier clamp** | The screenshot interval is 0 or no more often than the tier (B11) | — |
| **Pause** | `monitoring_pauses` row: a window when one employee is not monitored (D31) | "suspension" |
| **Pause in force** | Not cancelled and `starts_at` ≤ now < `ends_at`. Sent on the heartbeat as `monitoring_pause` | — |
| **Global minimum** | Greatest `min_supported` of the newest live `agent` release for a platform | — |
| **Effective minimum** | Greater of the global minimum and `companies.min_agent_version`. Drives `min_agent_version` and the `outdated` badge | — |
| **Collection notice** | `notice_text` + `notice_version` the employee acknowledges (D25) | — |

## Access

| Term | Meaning | Avoid |
|---|---|---|
| **Scope** | `app.scope` set per transaction: `tenant`, `staff` or `system` (B2) | "context" |
| **Tenant scope** | One company's rows, `app.company_id` set from the credential | — |
| **Staff scope** | `super_admin` routes. Never employee, device or activity data (D41) | — |
| **System scope** | `/cron/*` routes only. Sees every company | — |
| **Lookup** | `SECURITY DEFINER` function resolving a credential before a tenant is known (B3) | "bypass" |
| **Roles** | `company_admin`, `manager`, `it_admin` (company); `super_admin` (staff) | "owner", "admin" alone |
| **Team** | The employees whose `manager_user_id` is a manager. One manager per employee (B12) | — |

## Health and data

| Term | Meaning | Avoid |
|---|---|---|
| **Heartbeat** | `POST /v1/agents/heartbeat` every 5 min. Latest values only, no history | "ping" |
| **Offline** | No heartbeat for 15 min, decided only by `/cron/heartbeat-check` | An agent-sent event |
| **Tamper event** | One of five agent types, or backend `offline`. Also the alerts feed | "incident" |
| **Device status** | Derived on read: `released`, `deactivated`, `tamper`, `offline`, `online` | A stored column |
| **Badge** | `outdated`, `permission_pending`, `browser_access_pending`, `paused` | "status" |
| **Batch** | One sealed activity upload, `batch_id` = `Idempotency-Key` (D13) | "sync" |
| **Time window** | Records outside [now − 8 days, now + 1 day] are dropped and counted (B7) | — |
| **Retention** | `companies.data_retention_days`, 1–365 (B13) | — |
| **Company timezone** | `companies.timezone`, IANA, default `UTC`; bounds days and digests (B19) | — |
