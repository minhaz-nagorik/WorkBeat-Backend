# Policy resolution

How `GET /v1/agents/policy` is assembled for one device, how its version moves, and when it costs
only a `304`. The agent's view is each agent repository's `docs/domain/policy-model.md`.
Requirements: [`agent-policy`](../openspec/changes/serve-agent-policy/specs/agent-policy/spec.md),
[`monitoring-settings`](../openspec/changes/manage-employees/specs/monitoring-settings/spec.md),
[`monitoring-pauses`](../openspec/changes/manage-employees/specs/monitoring-pauses/spec.md),
[`agent-updates`](../openspec/changes/distribute-agents/specs/agent-updates/spec.md),
[`agent-releases`](../openspec/changes/distribute-agents/specs/agent-releases/spec.md),
[`collection-notice`](../openspec/changes/serve-agent-policy/specs/collection-notice/spec.md).

The device key gives `device_id`, `company_id` and `employee_id`. Nothing in the request can
change them. A released device or a replaced key gets `401` and no policy; a suspended or expired
company gets `402`.

## Where each field comes from

| Field | Source | Notes |
|---|---|---|
| `policy_version` | `greatest(companies, employee_monitoring_settings, devices).policy_version` | B5, below |
| `block_rules[]` | `block_rules` of the company: `id`, `type`, `pattern`, `reason` | `domain` or `url` only (D39) |
| `sensitive_domains[]` | `sensitive_domains.pattern` of the company | Defaults seeded at signup (D4) |
| `screenshot_interval_seconds` | `employee_monitoring_settings` of the device's employee | 0, 600, 1800, 3600; 0 when the tier is `off` (B11) |
| `idle_threshold_seconds` | `companies` | 60–3600 (D15) |
| `min_agent_version` | Effective minimum: greater of `companies.min_agent_version` and the platform's global minimum from `agent_releases` | B16 note below |
| `update_package_url` | Newest non-withdrawn `agent` release for `devices.os`: `universal` on macOS, `devices.arch` on Windows | Signed once per release per UTC day, valid to the end of the next day (B16); null if none |
| `update_package_sha256` | That release's `sha256` | null if none |
| `uninstall_token_hash` | `companies.uninstall_token_hash` | D19 |
| `collection_notice` | `companies.notice_text`, `notice_version` | D25 |
| `monitoring_features` | `activity`, `app_usage`, `window_titles`, `website_visits` of the employee's settings | D37 |
| `monitoring_pauses[]` | The employee's `monitoring_pauses` with `cancelled_at` NULL and `ends_at` > now, as `{ pause_id, starts_at, ends_at }` | Future and in force |

Productivity rules are not in the policy: they are applied when a report is read.

## Per-employee settings (D37)

- One settings row per employee, created by trigger with the employee: every switch on, interval
  = `tier_interval(screenshot_tier)`.
- Only a `company_admin` writes them (`PUT /v1/employees/:id/monitoring-settings`). A manager reads
  their team's; IT gets `403`.
- Turning a switch on or shortening the interval changes only the settings row and its version.
  `notice_version` does not move; the agent re-asks for the notice itself.
- A device always receives its binding's employee's settings; that employee never changes (D48).

## Tier clamp (B11)

| When | What happens |
|---|---|
| Admin saves an interval | Must be 0, or no more often than the tier; tier `off` allows only 0. Else `422` |
| Tier lowered (Stripe event) | Every interval above 0 and below the new tier interval is raised to it |
| Tier set to `off` | Every interval set to 0 |
| Tier raised | Rows unchanged; admins widen them by hand |
| New employee | Starts at the current tier interval |

Each rewritten row is an update, so it raises that employee's `policy_version`.

## Pauses: policy versus heartbeat

| Where | What is sent | Why |
|---|---|---|
| Policy `monitoring_pauses[]` | Every live pause not yet ended: future and in force | Agent can start a pause on time, even offline (D31) |
| Heartbeat `monitoring_pause` | Only the pause in force (`starts_at` ≤ now < `ends_at`), the one ending last if several, else null | A paused agent does not fetch policy (D32), so the heartbeat carries the extension or cancellation |

Pauses never overlap for one employee (exclusion constraint, `409 CONFLICT`). Create, extend and
cancel each touch the employee's settings row, which raises its version.

## Version: greatest of three (B5)

All three columns draw from one sequence, `policy_version_seq`. Every bump takes a new, higher
value, so the greatest of the three can never go down.

| Column | Bumped by |
|---|---|
| `companies.policy_version` | Trigger on `notice_text`, `notice_version`, `idle_threshold_seconds`, `min_agent_version`, `uninstall_token_hash`; any insert, update or delete of `block_rules` or `sensitive_domains`; publish or withdraw of an `agent` release (every company) |
| `employee_monitoring_settings.policy_version` | Every update of the row: settings `PUT`, tier clamp, and any pause insert, update or delete |
| `devices.policy_version` | Taken at insert; never bumped, since a binding's employee never changes (0003 drops `devices_policy_bump`) |

### Worked example: a settings change

| Moment | Company | Employee A | Device | Device's version |
|---|---|---|---|---|
| Device bound to A | 105 | 230 | 40 | 230 |
| Admin turns off A's window titles | 105 | **231** | 40 | 231 |
| Admin adds a block rule | **232** | 231 | 40 | 232 |
| Admin pauses A | 232 | **233** | 40 | 233 |

Each change takes the next sequence value, so the greatest always rises. With a counter per scope,
the block rule would have moved the company from 105 to 106, still below A's 231, and the agent
would never have seen it.

## ETag and 304

- `ETag` = hash of the resolved body, so no version table is needed.
- `If-None-Match` equal to it → `304`, no body.
- The body can change without the version: a pause passing its `ends_at` leaves the list, and the
  update URL is re-signed daily. The 30-minute fetch with the ETag picks these up; a `304` never
  confirms an expired URL (B16).
- The heartbeat returns `policy_version`; an agent seeing a higher number fetches early.

## Gaps found

- **Release publish bump is not a trigger.** `agent-releases` requires every company's
  `policy_version` to rise on publish or withdraw. data-model.md says the sequence is "bumped only
  by triggers", and no trigger exists on `agent_releases`. The API must do it in staff scope.
- **Stale design.** [distribute-agents design.md](../openspec/changes/distribute-agents/design.md)
  says `agent_releases.signature` is `NOT NULL` and Windows stores `''`; `0002` made it nullable.
- **Tier `off` read clamp.** `agent-policy` says the interval is "0 when the tier is `off`", which
  could mean a read-time clamp as well as the stored rewrite. Both give the same answer today.
