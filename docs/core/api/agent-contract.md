# Agent and Downloader contract

What the Mac and Windows agents and the Downloader call, and what they do with every answer. The
agent repositories specify the client side (`docs/core/architecture/backend-api-integration.md`,
`docs/core/network/status-code-handling.md` in each). **This repository is the producer**: its
specs must satisfy every row here (B9). Exact zod schemas live in `packages/shared`.

Base path `/v1`. Every response is `{ "data": … }` or `{ "error": "<message>", "code": "<CODE>" }`.
Clients branch on HTTP status and `code`, never on `error`. Every response carries a `Date` header
(the agents anchor pause ends and `blocking_ends_at` to it, D31, D36) and `X-Request-Id`.

## Routes

| Caller | Route | Auth | Purpose |
|---|---|---|---|
| Downloader | `POST /license/validate` | `X-License-Key` | Step 1 (no `employee_id`): company name and employee list. Step 2 (`employee_id`): also a single-use enrollment token (D26, D43, D47, B8) |
| Agent service | `POST /devices/enroll` | `Authorization: Bearer <enrollment token>` | Bind the device ID, the licence and the token's employee; get `device_id` and the device key (D3, D2, D48) |
| Agent service | `POST /agents/heartbeat` | `X-Device-Key` | Every 5 min; response carries `policy_version` and `monitoring_pause` |
| Agent service | `GET /agents/policy` | `X-Device-Key`, `If-None-Match` | Every 30 min; `304` when the ETag matches (D8) |
| Agent service | `POST /agents/activity` | `X-Device-Key`, `Idempotency-Key` | One sealed batch: `app_sessions[]`, `url_visits[]`, `activity_buckets[]`, `idle_intervals[]`; any may be empty (D13, D37) |
| Agent service | `POST /agents/screenshots` | `X-Device-Key`, `Idempotency-Key` | Request a signed upload URL for screenshot `id`; then `PUT` the JPEG; then `POST /agents/screenshots/:id/confirm` |
| Agent service | `POST /agents/tamper` | `X-Device-Key` | One tamper event, sent as soon as detected; `id` is its idempotency key (D24) |
| Uninstaller | `POST /devices/:id/deactivate` | `X-Device-Key` | Free the seat before removal (D19) |
| Agent service | `GET` the signed `update_package_url` from policy | signed URL | Self-update (D40) |

## Payload fields

- **Licence validation:** step 1 sends nothing but the header and returns `company_name` and
  `employees[]` (`id`, `name`, `email`, `department`). Step 2 sends `employee_id`, `os` and `arch`
  and also returns `enrollment_token` (single-use, 24 h), `package_url` (short-lived signed) and
  `package_sha256` (B8).
- **Enroll request:** `hostname`, `os` (`macos` \| `windows`), `os_version`, `arch`, `model`,
  `serial_number`, `hardware_id` (device ID the agent produces, format open — Q10), `agent_version`,
  `enrolled_via` (`manual`), `employee_id`. **Response:** `device_id`, `device_key`, `outcome`
  (`new_binding` \| `same_binding`), `notice_required` (`true` for a new binding, `false` for the
  same one, D46).
- **Enrollment outcomes.** The live binding is the company's `devices` row with this `hardware_id`
  and `released_at` NULL. None: a new binding for the token's employee, which takes a seat. Live for
  the token's employee: the same binding (D2), with a new key, the old key revoked, and the seat
  kept or taken again if it was deactivated. Live for another employee: `409 DEVICE_ASSIGNED` and
  nothing is written; the device has to be released first (D48). A same-binding re-enroll while the
  previous key heartbeated in the last 15 minutes also raises a `duplicate_device_id` tamper event
  (D46).
- **Heartbeat request:** `agent_version`, `os_version`, `policy_version`, `outdated`, `helper_status`,
  `browser_access`, `permissions` (Windows: `not_required`), `store_bytes`, `oldest_unsent_at`,
  `dropped_records`, `dropped_samples`, `screenshot_skips`, `quarantined_batches`,
  `blocking_status`, `helper_restarts_24h`, `upload_failures_24h`, `update_failure`,
  `active_pause_id`, `notice_version`, `notice_acknowledged_at`, `uptime_seconds`.
  **Response:** `policy_version`, `monitoring_pause` (`{ pause_id, starts_at, ends_at }` or `null`).
- **Policy response:** `policy_version`, `block_rules[]` (`{ id, type: domain|url, pattern, reason }`),
  `sensitive_domains[]`, `screenshot_interval_seconds` (0, 600, 1800, 3600), `idle_threshold_seconds`,
  `min_agent_version`, `update_package_url`, `update_package_sha256`, `uninstall_token_hash`,
  `collection_notice` (`{ text, version }`), `monitoring_features`
  (`{ activity, app_usage, window_titles, website_visits }`), `monitoring_pauses[]`.
- **Activity batch:** `batch_id` (= `Idempotency-Key`) and four arrays whose rows mirror the
  agents' offline store: app session (`session_user`, `bundle_id`, `app_name`, `process_name`,
  `window_title`, `started_at`, `ended_at`, `duration_seconds`, `clock_flag`), URL visit
  (`session_user`, `browser`, `url`, `domain`, `visited_at`, `duration_seconds`), activity bucket
  (`bucket_start`, `active_samples`, `total_samples`), idle interval (`session_user`, `started_at`,
  `ended_at`). Times are Unix milliseconds, UTC. **Response:** accepted counts and
  `dropped_out_of_window` (B7).
- **Tamper event:** `id`, `event_type` (`process_restart`, `hosts_modified`, `config_changed`,
  `clock_tampered`, `permission_revoked`), `detail`, `occurred_at`, `repeat_count`. The agents
  never send `offline` or `duplicate_device_id`; the backend writes those.

## Status and code catalog

| Status | `code` | When | Agent reaction (their spec) |
|---|---|---|---|
| 200 / 201 / 204 | — | Success, including a repeated idempotency key with the same body | Clear the batch / apply |
| 304 | — | Policy ETag matches | Keep cached policy |
| 400 | `VALIDATION_FAILED` | Malformed body | Quarantine, never retry |
| 401 | `DEVICE_REVOKED` | Unknown, replaced or deactivated device key | Stop collecting, keep store and blocks, re-enroll if it can (D6) |
| 401 | `DEVICE_RELEASED` + `released_at`, `upload_until` | The device's company released it; `upload_until` = `released_at` + 24 h | Stop collecting, lift blocking, upload what it holds until `upload_until`, then wipe and go dormant (D38, D45) |
| 402 | `COMPANY_SUSPENDED` | Company suspended, including a failed renewal (D29) | Stop collecting, keep blocking, heartbeat only (D5) |
| 402 | `LICENSE_EXPIRED` + `blocking_ends_at` | Licence expired; `blocking_ends_at` = expiry + grace days (D30, D36) | As suspended, then `ended` after `blocking_ends_at` |
| 402 | `LICENSE_SUSPENDED` | `/license/validate` or enroll while suspended | Downloader shows it |
| 403 | `SEAT_LIMIT_EXCEEDED` | No free seat at validate or enroll (D43) | Show; retry each policy interval |
| 403 | `ENROLLMENT_TOKEN_EXPIRED` | Token older than 24 h | Show; Downloader runs again |
| 403 | `ENROLLMENT_TOKEN_EXHAUSTED` | Token already used | Show |
| 404 | `LICENSE_NOT_FOUND` | Unknown licence key (including the key before a reissue) | Downloader shows "wrong key" |
| 404 | `ENROLLMENT_TOKEN_INVALID` | Unknown token (including unused tokens deleted by a key reissue) | Show "wrong key" |
| 404 | `EMPLOYEE_NOT_FOUND` | `employee_id` not an active employee of the company (D47) | Downloader shows it |
| 403 | `FORBIDDEN` | The uninstaller's `POST /v1/devices/:id/deactivate` names another device's `id` | Uninstaller keeps its sealed deactivation record |
| 404 | `NOT_FOUND` | `POST /v1/agents/screenshots/:id/confirm` for an unknown screenshot `id` | Re-request the upload URL next sync |
| 409 | `DEVICE_ASSIGNED` | Enroll: the device ID has a live binding for another employee; nothing written (D48) | Setup rolls back and tells IT to release the device first |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Same key, different body | Quarantine |
| 413 | `PAYLOAD_TOO_LARGE` | Body over the limit | Quarantine |
| 422 | `VALIDATION_FAILED` | Schema-valid but semantically wrong | As 400 |
| 429 | `RATE_LIMITED` + `Retry-After` | Too many requests | Wait, then back off |
| 5xx | `INTERNAL` | Server error | Back off, keep |
| 503 | `SERVICE_UNAVAILABLE` | `GET /health` only, when the database is unreachable | — |

`POST /v1/devices/:id/deactivate` is the one agent route never answered with `402` (B17).

A released key is still accepted on `POST /v1/agents/activity`, `POST /v1/agents/screenshots` and
`POST /v1/agents/screenshots/:id/confirm` for 7 days after `released_at`; the records are stored
under the released binding (B21, D45). Every other route answers it `401 DEVICE_RELEASED`. Records
always belong to the binding whose key uploaded them; nothing is re-credited by time (D48).

**Portal-only codes** (the web platform, not the agents): `UNAUTHENTICATED` 401, `FORBIDDEN` 403,
`MFA_REQUIRED` 403, `NOT_FOUND` 404, `INVITATION_INVALID` 404, `CONFLICT` 409,
`EMPLOYEE_HAS_DEVICES` 409, `INVITATION_EXPIRED` 410, `EXPORT_TOO_LARGE` 422,
`WEBHOOK_SIGNATURE_INVALID` 400 (Stripe only).

`ENROLLMENT_TOKEN_REVOKED` in the agents' list is never returned: there are no portal tokens since
D43, and a reissue deletes unused tokens, which then answer `ENROLLMENT_TOKEN_INVALID`.
