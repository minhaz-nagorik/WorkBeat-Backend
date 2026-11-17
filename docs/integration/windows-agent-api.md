# WorkBeat API — Windows agent integration

What the Windows agent, Downloader and uninstaller send to the WorkBeat backend, what comes back, and
how to react. Everything here is implemented in `apps/api` and checked end to end by
`pnpm smoke`. The normative contract is [agent-contract.md](../core/api/agent-contract.md); the
exact field rules live in [`apps/api/src/contract.ts`](../../apps/api/src/contract.ts). The macOS
version of this page is [mac-agent-api.md](mac-agent-api.md); only the
[Windows specifics](#windows-specifics) differ.

## Contents

[Basics](#basics) · [Flow](#flow) · [Validate licence](#1-post-v1licensevalidate) ·
[Enroll](#2-post-v1devicesenroll) · [Heartbeat](#3-post-v1agentsheartbeat) ·
[Policy](#4-get-v1agentspolicy) · [Activity](#5-post-v1agentsactivity) ·
[Screenshots](#6-screenshots) · [Tamper](#7-post-v1agentstamper) ·
[Deactivate](#8-post-v1devicesiddeactivate) · [Status and code reactions](#status-and-code-reactions) ·
[Windows specifics](#windows-specifics) · [Not available yet](#not-available-yet)

---

## Basics

| | |
|---|---|
| Base URL | `<host>/api/v1`, e.g. `https://….trycloudflare.com/api/v1` (local: `http://localhost:3000/api/v1`). Routes below are written in full as `/v1/…`; with that base URL send `/agents/…`, `/devices/…`, `/license/…`. `<host>/v1/…` works too. Signed URLs (`upload_url`, `package_url`) are absolute: use them as given |
| Body | JSON, `Content-Type: application/json`, UTF-8. Max 1 MiB (activity: 8 MiB) → `413 PAYLOAD_TOO_LARGE` |
| Success | `{ "data": … }`. `204` and `304` have no body |
| Error | `{ "error": "<human text>", "code": "<CODE>", …extra }`. **Branch on HTTP status and `code` only**, never on `error` |
| Validation error | `400` or `422` with `code` `VALIDATION_FAILED` and `fields`: the failing field paths (e.g. `["app_sessions.3.ended_at"]`). Both mean: quarantine, never retry the same body |
| Unknown fields | Ignored and never stored. Safe to send extra fields from newer agents |
| Times you send | Unix **milliseconds** UTC (integer), or an ISO 8601 string with offset. Prefer milliseconds |
| Times you receive | ISO 8601 UTC strings, e.g. `"2026-11-17T07:09:03.304Z"` |
| `Date` header | On every response. Use it, not the PC clock, to anchor pause ends and `blocking_ends_at` |
| `X-Request-Id` | Echoed if you send one (`[A-Za-z0-9_.-]`, ≤ 128 chars), otherwise generated. Log it with failures |
| Rate limit | 120 requests/min per device key; `/v1/license/validate` 20/min per IP. Over → `429 RATE_LIMITED` with `Retry-After` (seconds) |
| Health | `GET /health` → `200 {"data":{"status":"ok"}}`, `503 SERVICE_UNAVAILABLE` when the database is down. No credential |

**Credentials** (keep in a DPAPI-protected store readable only by the service, never log them, never put them in a URL you log):

| Credential | Format | Sent as | Obtained from |
|---|---|---|---|
| Licence key | `WB-XXXX-XXXX-XXXX-XXXX` (letters and digits; case and surrounding spaces ignored) | `X-License-Key` | Typed by IT in the Downloader |
| Enrollment token | `wbe_…` (single use, 24 h) | `Authorization: Bearer <token>` | `/v1/license/validate` step 2 |
| Device key | `wbd_…` | `X-Device-Key` | `/v1/devices/enroll` |

## Flow

```
Downloader:  POST /v1/license/validate            (step 1: key → company + employees)
             POST /v1/license/validate            (step 2: + employee_id, os, arch → enrollment_token, package_url)
             download package_url, check package_sha256, install, hand the token to the agent
Agent:       POST /v1/devices/enroll              (token → device_id + device_key; store both)
             GET  /v1/agents/policy               (at start, then every 30 min, or sooner when heartbeat's policy_version moves)
             POST /v1/agents/heartbeat            (every 5 min)
             POST /v1/agents/activity             (one sealed batch every 10 min)
             POST /v1/agents/screenshots → PUT upload_url → POST …/confirm   (per capture)
             POST /v1/agents/tamper               (as soon as detected)
Uninstaller: POST /v1/devices/:id/deactivate      (frees the seat)
```

---

## 1. `POST /v1/license/validate`

Downloader only. Two steps; neither reserves a seat. (Plan v3.5 D43/B8: the licence key is the only install credential and the token is issued for the employee IT picks. A single call with hostname and hardware ID is the older design; those fields are ignored.)

Headers: `X-License-Key: WB-…`. The key in a body is never read.

Body (all optional):

| field | type | notes |
|---|---|---|
| `employee_id` | uuid | Omit for step 1. Step 2: the employee IT picked |
| `os` | `"windows"` | Step 2: needed to get `package_url` |
| `arch` | `"x64"` \| `"arm64"` | Step 2: the PC's CPU; picks the matching MSI |

Step 1 request `{}` → `200`:

```json
{ "data": {
  "company_name": "Acme Test",
  "employees": [
    { "id": "cd6e5064-d446-4ec5-9582-b5b2d49e6bf6", "name": "Ada Lovelace", "email": "ada.lovelace@example.test", "department": null }
  ] } }
```

Employees are active ones only, ordered by name. `email` and `department` may be `null`. There is no search route: the dropdown filters this list on the device. Scripted installs pick by `employee_id`, or match an email in this list locally (an employee without an email can only be picked by ID).

Step 2 request `{ "employee_id": "cd6e…", "os": "windows", "arch": "x64" }` → `200`: the step-1 fields plus

```json
{ "enrollment_token": "wbe_…", "expires_at": "2026-11-17T07:09:03.304Z",
  "package_url": "https://…/v1/storage/agents/…?exp=…&sig=…", "package_sha256": "9f2c…" }
```

`package_url` is a signed plain `GET` (no headers), valid 1 hour. It and `package_sha256` are
`null` when no agent release is published yet. Calling step 2 again issues a second token; both stay
valid until used or expired.

| status | code | show |
|---|---|---|
| 404 | `LICENSE_NOT_FOUND` | Wrong key (also a key replaced by a reissue, or no header) |
| 402 | `LICENSE_SUSPENDED` | Company suspended |
| 402 | `LICENSE_EXPIRED` | Subscription ended (`blocking_ends_at` included) |
| 403 | `SEAT_LIMIT_EXCEEDED` | No free seat |
| 404 | `EMPLOYEE_NOT_FOUND` | Picked employee archived or not in the company — reload the list |
| 400 | `VALIDATION_FAILED` | Bad `employee_id`/`os`/`arch`; no token issued |
| 429 | `RATE_LIMITED` | Wait `Retry-After` |

## 2. `POST /v1/devices/enroll`

Agent service, once after install (and again after a reinstall with a new token).

Headers: `Authorization: Bearer wbe_…`.

| field | type | required | notes |
|---|---|---|---|
| `hostname` | string 1–255 | yes | |
| `os` | `"windows"` | yes | |
| `os_version` | string 1–64 | yes | e.g. `"10.0.22631"` |
| `arch` | `"arm64"` \| `"x64"` | yes | |
| `model` | string ≤ 128 \| null | no | e.g. `"Latitude 7440"` |
| `serial_number` | string ≤ 128 \| null | no | |
| `hardware_id` | string 1–256 | yes | Stable device ID that survives a reinstall (see [Windows specifics](#windows-specifics)) |
| `agent_version` | string 1–32 | yes | `x.y.z` |
| `enrolled_via` | `"manual"` | no | Default `manual`; any other value → 400 |
| `employee_id` | uuid | no | If sent, must equal the token's employee, else `422`. The device is always bound to the token's employee |

`201` (both outcomes):

```json
{ "data": { "device_id": "06e332b3-48fc-4a56-a25f-f12406f83bd3", "device_key": "wbd_…",
            "outcome": "new_binding", "notice_required": true } }
```

| `outcome` | meaning | `notice_required` |
|---|---|---|
| `new_binding` | First enrollment of this `hardware_id` for this employee; a seat was taken | `true` — show the collection notice |
| `same_binding` | This PC was already bound to the same employee. Same `device_id`, **new key; the old key now gets `401 DEVICE_REVOKED`** | `false` |

Store `device_id` and `device_key` before anything else. The key is returned once; a retry with the
same token gets `403 ENROLLMENT_TOKEN_EXHAUSTED`, so a lost response needs a new token (run the
Downloader again).

Checked in this order; the first failure answers:

| status | code | reaction |
|---|---|---|
| 404 | `ENROLLMENT_TOKEN_INVALID` | Unknown token. Show "wrong key", rerun Downloader |
| 403 | `ENROLLMENT_TOKEN_EXHAUSTED` | Token already used |
| 403 | `ENROLLMENT_TOKEN_EXPIRED` | Older than 24 h. Rerun Downloader |
| 400 | `VALIDATION_FAILED` | Bad body; token stays unused |
| 422 | `VALIDATION_FAILED` | `employee_id` ≠ token's employee |
| 402 | `LICENSE_SUSPENDED` / `LICENSE_EXPIRED` | Show; token stays usable until it expires |
| 404 | `EMPLOYEE_NOT_FOUND` | Employee archived since validation |
| 409 | `DEVICE_ASSIGNED` | This `hardware_id` is bound to **another** employee. Roll back setup; IT must release the device in the portal first. Nothing was written |
| 403 | `SEAT_LIMIT_EXCEEDED` | No free seat; retry each policy interval |

A failed enrollment leaves the token unused.

---

From here on every route takes `X-Device-Key: wbd_…`. See [Status and code reactions](#status-and-code-reactions)
for the `401`/`402` answers shared by all of them.

## 3. `POST /v1/agents/heartbeat`

Every 5 minutes. Only `agent_version` is required; send everything you have.

| field | type | notes |
|---|---|---|
| `agent_version` | string | **required** |
| `os_version` | string | omitted = keep the stored one |
| `policy_version` | int \| null | the version the agent has applied |
| `outdated` | bool | below `min_agent_version` |
| `helper_status` | string | **Windows:** `"running"` \| `"not_running"` \| `"no_session"` |
| `browser_access` | object | per browser: `{ "edge": "granted" \| "unreadable" }` |
| `permissions` | string | **Windows:** always `"not_required"` |
| `dropped_records`, `dropped_samples`, `screenshot_skips` | int ≥ 0, or an object of ints ≥ 0 by type/reason, e.g. `{ "app_sessions": 2 }` | negative → `422` |
| `store_bytes`, `quarantined_batches`, `helper_restarts_24h`, `upload_failures_24h`, `uptime_seconds` | int ≥ 0 | negative → `422` |
| `oldest_unsent_at` | time \| null | |
| `blocking_status` | string ≤ 32 \| null | e.g. `applied`, `degraded`, `off` |
| `update_failure` | string ≤ 256 \| null | step a self-update failed at |
| `active_pause_id` | uuid \| null | pause the agent is applying |
| `notice_version` + `notice_acknowledged_at` | int + time | **send both or neither**; recorded once per device, employee and version. Repeat it on every heartbeat until the version changes — harmless |

```json
{ "agent_version": "1.0.0", "os_version": "10.0.22631", "policy_version": 42,
  "helper_status": "running", "browser_access": { "edge": "granted", "chrome": "unreadable" },
  "permissions": "not_required",
  "store_bytes": 1048576, "oldest_unsent_at": 1794812400000, "dropped_records": 0, "dropped_samples": 0,
  "screenshot_skips": 0, "quarantined_batches": 0, "blocking_status": "applied", "helper_restarts_24h": 0,
  "upload_failures_24h": 0, "update_failure": null, "active_pause_id": null,
  "notice_version": 1, "notice_acknowledged_at": 1794812000000, "uptime_seconds": 3600 }
```

`200`:

```json
{ "data": { "policy_version": 42,
            "monitoring_pause": { "pause_id": "…", "starts_at": "2026-11-16T09:00:00.000Z", "ends_at": "2026-11-16T17:00:00.000Z" } } }
```

- `policy_version` higher than the one applied → fetch policy now.
- `monitoring_pause` is the pause in force now, or `null`. Stop collecting until `ends_at` (judged by
  the `Date` header); a cancelled or shortened pause shows up on the next heartbeat.
- A heartbeat answered `402` is **still recorded** (the PC stays online in the portal).

## 4. `GET /v1/agents/policy`

At start, every 30 minutes, and whenever the heartbeat's `policy_version` is higher than yours.
Send the last `ETag` as `If-None-Match` (exact string, quotes included) → `304` with no body when
nothing changed.

`200` with an `ETag` header:

```json
{ "data": {
  "policy_version": 42,
  "block_rules": [ { "id": "…", "type": "domain", "pattern": "games.example", "reason": "Not work" },
                   { "id": "…", "type": "url", "pattern": "example.com/videos", "reason": null } ],
  "sensitive_domains": ["chase.com", "mail.google.com", "paypal.com"],
  "screenshot_interval_seconds": 1800,
  "idle_threshold_seconds": 300,
  "min_agent_version": null,
  "update_package_url": null,
  "update_package_sha256": null,
  "uninstall_token_hash": "10b038f3…",
  "collection_notice": { "text": "This computer is monitored…", "version": 1 },
  "monitoring_features": { "activity": true, "app_usage": true, "window_titles": true, "website_visits": true },
  "monitoring_pauses": [ { "pause_id": "…", "starts_at": "…", "ends_at": "…" } ] } }
```

| field | how to apply |
|---|---|
| `block_rules` | `type` is only `domain` or `url` (no regex). Always an array |
| `sensitive_domains` | Bare host names; cover subdomains. Never log URLs or titles on them |
| `screenshot_interval_seconds` | `0` (off), `600`, `1800` or `3600` |
| `idle_threshold_seconds` | 60–3600 |
| `min_agent_version` | `x.y.z` or `null`; below it → report `outdated: true` |
| `update_package_url` / `_sha256` | Signed `GET` to a newer agent, or `null`. Verify the hash before installing. URL changes at most daily |
| `uninstall_token_hash` | SHA-256 hex of the uninstall token; the uninstaller compares the token IT types against it |
| `collection_notice` | Show `text` when `version` is new; acknowledge on the heartbeat |
| `monitoring_features` | Switch each collector on or off |
| `monitoring_pauses` | Current and future pauses (cancelled and ended ones are left out), current first |

## 5. `POST /v1/agents/activity`

One sealed batch, every 10 minutes. Headers: `X-Device-Key`, **`Idempotency-Key: <batch_id>`** (must
equal the body's `batch_id`, else `400`). Max 8 MiB.

| field | type | notes |
|---|---|---|
| `batch_id` | uuid (UUIDv7 recommended) | fixed when the batch is sealed |
| `app_sessions` | array | `session_user`, `bundle_id`, `app_name`, `process_name` (optional, default `""`), `window_title` (`""` when withheld), `started_at`, `ended_at` (≥ `started_at`), `duration_seconds` ≥ 0, `clock_flag` bool (or `clock_suspect`; either true marks the record) |
| `url_visits` | array | `session_user`, `browser`, `url`, `domain`, `visited_at`, `duration_seconds` ≥ 0 |
| `activity_buckets` | array | `bucket_start`, `active_samples` ≤ `total_samples`, `total_samples` |
| `idle_intervals` | array | `session_user`, `started_at`, `ended_at` (≥ `started_at`) |

Any array may be empty or omitted. Times: Unix ms.

```json
{ "batch_id": "0196f5a2-7c1e-7000-8000-00000000000a",
  "app_sessions": [ { "session_user": "ACME\\ada", "bundle_id": "MSEdge", "app_name": "Microsoft Edge", "process_name": "msedge.exe",
                      "window_title": "", "started_at": 1794812340000, "ended_at": 1794812400000, "duration_seconds": 60, "clock_flag": false } ],
  "url_visits": [ { "session_user": "ACME\\ada", "browser": "edge", "url": "https://example.com/", "domain": "example.com",
                    "visited_at": 1794812370000, "duration_seconds": 30 } ],
  "activity_buckets": [ { "bucket_start": 1794812340000, "active_samples": 5, "total_samples": 6 } ],
  "idle_intervals": [] }
```

`200`:

```json
{ "data": { "batch_id": "0196f5a2-…", "accepted": { "app_sessions": 1, "url_visits": 1, "activity_buckets": 1, "idle_intervals": 0 },
            "dropped_out_of_window": 0 } }
```

- **Exactly once.** Resending the same batch (same id, same content) returns the first answer and
  stores nothing again. Resend the stored bytes unchanged; a changed body with the same id →
  `409 IDEMPOTENCY_KEY_REUSED` (quarantine).
- **Time window.** Records dated before server now − 8 days or after now + 1 day are dropped and
  counted in `dropped_out_of_window`; the rest is stored. Not an error.
- **Buckets** with the same `bucket_start` in one batch: the last one wins. A bucket sent again in a
  later batch replaces the stored samples.
- Any invalid record → the whole batch is refused with `400`/`422` and nothing is stored (quarantine).
- Clear the batch from the store on `200` only.

## 6. Screenshots

Three calls per capture. JPEG only, max 4 MiB (4,194,304 bytes).

**a. Request an upload** — `POST /v1/agents/screenshots`, headers `X-Device-Key`,
**`Idempotency-Key: <id>`** (= body `id`).

```json
{ "id": "0196f5a2-7c1e-7000-8000-000000000001", "captured_at": 1794812400000, "bytes": 183422 }
```

`201` first time, `200` on a repeat:

```json
{ "data": { "id": "0196f5a2-…", "status": "pending",
            "upload_url": "https://<account>.r2.cloudflarestorage.com/<bucket>/…/0196f5a2-….jpg?X-Amz-…&X-Amz-Signature=…",
            "expires_at": "2026-11-16T07:24:03.000Z" } }
```

A repeat for an already confirmed screenshot answers `status: "uploaded"`, `upload_url: null` — mark
it done. `422` for `bytes` over the limit or `captured_at` outside [now − 8 days, now + 1 day], and
`409 IDEMPOTENCY_KEY_REUSED` if the id exists with another `bytes`/`captured_at` or another device:
**drop that screenshot and count it in `screenshot_skips`** — retrying can never succeed. Fix the `id`
when the image is stored, so every retry reuses it.

**b. Upload** — `PUT <upload_url>` with `Content-Type: image/jpeg` and the raw JPEG bytes as the
body. No other headers. `200` with no body. The URL is valid 15 minutes; when expired (`403 FORBIDDEN`)
repeat step a for a fresh one. `upload_url` is a secret: never log it.

**c. Confirm** — `POST /v1/agents/screenshots/:id/confirm`, header `X-Device-Key`, no body.

| answer | meaning |
|---|---|
| `200 { id, status: "uploaded" }` | Done (repeats also `200`). Delete the local file |
| `422 VALIDATION_FAILED` | Object missing or size ≠ `bytes`; a wrong-size object is deleted. Go back to step a |
| `404 NOT_FOUND` | Unknown id. Re-request the upload next sync |

Screenshots are accepted even if the interval was just switched off (policy can be 30 minutes old).

## 7. `POST /v1/agents/tamper`

Send each event as soon as it is detected; queue offline and send later (any age is accepted).

| field | type | notes |
|---|---|---|
| `id` | uuid | idempotency key |
| `event_type` | `process_restart` \| `hosts_modified` \| `config_changed` \| `clock_tampered` \| `permission_revoked` | `offline` and `duplicate_device_id` are backend-only → `422` |
| `detail` | JSON object ≤ 4096 bytes | facts only (e.g. `{ "browser": "edge" }`); default `{}` |
| `occurred_at` | time | a future time is stored as server now |
| `repeat_count` | int ≥ 1 | default 1 |

`id` is required: it is how a resend after a lost response is recognised (D13). Generate it when the
event is detected and keep it with the queued event. `repeat_count` is the debounce count.

`201 { "data": { "id": "…", "received_at": "…" } }`; a repeat of the same `id` and `event_type`
→ `200` with the stored values (nothing changes, even a higher `repeat_count`). Same `id` with
another `event_type` or from another device → `409 IDEMPOTENCY_KEY_REUSED`. Any invalid field →
`422`. Use a new `id` for a new occurrence. A released device's key gets `401 DEVICE_RELEASED` here: leave
queued tamper events out of the release drain (they cannot be sent).

## 8. `POST /v1/devices/:id/deactivate`

Uninstaller, before removing the agent. Header `X-Device-Key`; `:id` = own `device_id`. No body.

| answer | meaning |
|---|---|
| `204` | Seat freed, key cleared |
| `403 FORBIDDEN` | `:id` is not this key's device; keep the sealed deactivation record |
| `401 DEVICE_REVOKED` | Already deactivated (e.g. retry after a lost `204`) — treat as done |
| `401 DEVICE_RELEASED` | Released in the portal; nothing to free |

Never answered `402`: a suspended company can still uninstall.

---

## Status and code reactions

Applies to every `X-Device-Key` route.

| status | code | when | reaction |
|---|---|---|---|
| 200 / 201 / 204 | — | success, including a repeated idempotency key with the same body | clear / apply |
| 304 | — | policy unchanged | keep cached policy |
| 400 / 422 | `VALIDATION_FAILED` | bad body (`fields` lists paths) | quarantine, never retry that body |
| 401 | `DEVICE_REVOKED` | missing, unknown, replaced or deactivated key | stop collecting, keep store and blocks, re-enroll if it can |
| 401 | `DEVICE_RELEASED` + `released_at`, `upload_until` | released by the company | stop collecting, lift blocking, upload what it holds until `upload_until` (released_at + 24 h), then wipe and go dormant. Activity and screenshot uploads stay accepted for 7 days after `released_at`; every other route answers this |
| 402 | `COMPANY_SUSPENDED` | company suspended | stop collecting, keep blocking, heartbeat only |
| 402 | `LICENSE_EXPIRED` + `blocking_ends_at` | licence expired | as suspended; lift blocking after `blocking_ends_at` (compare to `Date`) |
| 409 | `IDEMPOTENCY_KEY_REUSED` | same id, different content | quarantine (take it out of the upload queue, so it never blocks oldest-first order) |
| 413 | `PAYLOAD_TOO_LARGE` | body over limit | quarantine; seal smaller batches from then on |
| 404 | `EMPLOYEE_NOT_FOUND` | Downloader / enroll: employee archived since the list was loaded | Downloader reloads the list; enroll treats it as a rejected enrollment |
| 429 | `RATE_LIMITED` + `Retry-After` | too many requests | wait, then back off |
| 500, 502, 503, 504 | `INTERNAL` (or none from the proxy) | server or tunnel error | retryable: back off, keep the data, retry with the same ids and the same body |

Example `401 DEVICE_RELEASED` body:

```json
{ "error": "Device released", "code": "DEVICE_RELEASED",
  "released_at": "2026-11-16T10:00:00.000Z", "upload_until": "2026-11-17T10:00:00.000Z" }
```

## Windows specifics

- `os` is always `"windows"`; `arch` is `x64` or `arm64`. Step 2 of `/v1/license/validate` returns the
  MSI for that architecture.
- `hardware_id`: the format is still open (Q10). It must be the same after a reinstall, or a
  reinstall takes a second seat (e.g. the SMBIOS system UUID or `MachineGuid`).
- `helper_status` is a single string: `running`, `not_running` or `no_session`. Any other value → `422`.
- `arch` is required on enroll (`x64` or `arm64`).
- `permissions` is the string `"not_required"` (W11).
- `browser_access` keys are browser names (`edge`, `chrome`, …): `granted`, or `unreadable` after
  10 minutes in the foreground with no URL.
- `bundle_id` in app sessions: Windows has no bundle ID; send the AppUserModelID when there is one,
  otherwise the executable name (e.g. `msedge.exe`). An empty string is accepted.
- If two PCs report the same `hardware_id` while one is live, the backend raises a
  `duplicate_device_id` alert; the agent does nothing.
- Windows MSIs are not signed (W35); always check `package_sha256` / `update_package_sha256`.

## Not available yet

- **Test host.** The test server is a `https://….trycloudflare.com` address that changes whenever the
  tunnel restarts. Debug builds need a rule that allows it (or a configurable base URL); this is the
  agent's build setting (Q6), not a backend one.

- `package_url` / `update_package_url` are `null` until staff publish an agent release
  (`POST /v1/staff/agent-releases`, built 17 Nov 2026).
- Screenshots are stored in Cloudflare R2: `upload_url` is an R2 presigned URL (an expired one
  returns `403` with an XML body, not JSON). The flow (request, `PUT`, confirm) stays
  the same — always use the URL you are given, never build one.
- Exact payload schemas are owned by this repository for now (`apps/api/src/contract.ts`); a shared
  package for the agents may follow.
