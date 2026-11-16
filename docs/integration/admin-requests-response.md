# Backend reply to WorkBeat Admin's requests

**Answers:** `WorkBeat-Admin/docs/backend-requests.md` (16 November 2026).
**State:** live in `apps/api` on `dev-minhaz`, covered by `pnpm smoke:portal`.

Before the items: the portal does **not** use Supabase. Sign-in is the API's own
(`POST /v1/auth/login` → `{ token, expires_at, user }`, then `Authorization: Bearer <token>`). Field
names chosen where `portal-api.md` leaves them open are listed in
[apps/api/README.md](../../apps/api/README.md#workbeat-api).

## Done

| # | Ask | What the API returns now |
|---|---|---|
| 1.1 | Time zone for every company role | `GET /v1/me` → `company.timezone` (IANA name) for every company role |
| 1.2 | Live status per employee | `GET /v1/employees` and `GET /v1/employees/:id` (company_admin, manager, same team scoping) add `presence` and `devices`. `presence` is the first that applies: `paused` (a pause in force), `no_device` (no device that is neither released nor deactivated), `tamper` (one of those devices is `tamper`), `active` / `idle` (the employee's latest activity bucket in the last 15 minutes has active samples / has none), else `offline`. `devices`: the employee's unreleased devices as `{ id, hostname, os, status, last_heartbeat_at }`. `it_admin` keeps the four B18 fields only |
| 1.3 | Define `health` | `GET /v1/devices/:id` → `health` always has: `store_bytes`, `oldest_unsent_at`, `dropped_records`, `dropped_samples`, `screenshot_skips`, `quarantined_batches`, `blocking_status`, `helper_restarts_24h`, `upload_failures_24h`, `update_failure`, `uptime_seconds` (latest heartbeat; `null` before the first), plus `outdated` (bool), `notice_ack_version`, `reported_policy_version`. `dropped_records`, `dropped_samples` and `screenshot_skips` are an int or an object of ints by type/reason, as the agent sent them |
| 2.1 | `group_by` on activity and productivity | `?group_by=day\|week\|month` adds `periods: [{ period_start, tracked_seconds, activity_percent, productive_seconds, neutral_seconds, unproductive_seconds }]`, one row per period in the effective range, zeros included. Weeks start Monday; `period_start` is the period's first day clipped to `from`. Any other value → `422`. No idle per period |
| 2.2 | Device dates | `released_at` and `deactivated_at` on every `GET /v1/devices` row |
| 2.3 | Manager filter | `GET /v1/employees?manager_user_id=<uuid>`; for a manager it is intersected with the own team |
| 2.4 | Rule author | `GET /v1/block-rules` rows carry `created_by_name` (`null` when the user is gone) |
| 2.5 | Alert counts | `GET /v1/alerts` → `{ items, next_cursor, counts }`; `counts` is `{ <event_type>: n }` for the current filters without `type` (and without the cursor) |
| 2.6 | Alerts per employee | `GET /v1/alerts?employee_id=<uuid>` (team scoping still applies) |
| 2.7 | Agent versions | `GET /v1/agent-versions` (company_admin, it_admin) → `{ macos: ["1.4.0", …], windows: [...] }`, live (non-withdrawn) agent versions, newest first |

## Not yet: they belong to the staff API

The staff routes (`/v1/staff/*`, staff MFA) are not built at all yet. These come with them:

- **1.4** `POST /v1/staff/agent-releases/upload-url` — agreed. It will return a signed upload URL and
  the `storage_path`, and publish will check size and SHA-256 as specified.
- **2.8** `POST /v1/staff/invitations/:id/resend` — agreed, same rules as the company team's resend.
- **2.9** `custom_domain_checked_at` on `GET /v1/staff/companies` — agreed. Custom domains
  themselves are also not built yet.

## Answers to section 3

- **"Check DNS now":** not planned. The console leaves it out; verification is the scheduled job only.
- **Global minimum version:** the derived rule is final (`min_supported` of the newest non-withdrawn
  release per platform, `agent-releases`). Show it read-only.
- **macOS uninstall command:** for the Mac agent owner, as you say.
