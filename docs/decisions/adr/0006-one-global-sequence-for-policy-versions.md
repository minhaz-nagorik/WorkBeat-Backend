# ADR 0006 — One global sequence for policy versions

**Status:** Accepted
**Date:** 2026-11-15
**Amends:** Plan-v3.5 §6.2 `policy_versions` table (company and employee scope, version,
updated_at). Open question Q13 asks the plan owner to edit the plan.

## Context

Each device fetches policy every 30 minutes with an ETag and gets `304` when nothing changed (D8).
Its heartbeat carries `policy_version` so a change can trigger an early fetch. A device's policy
mixes company fields (block rules, sensitive domains, notice, idle threshold, minimum version,
uninstall token hash) and its employee's settings and pauses (D31, D37). A device's version has to
rise whenever either part changes. If versions were counted per company and per employee, the
greatest of the two would hide a change in the smaller one, and the agent would never notice it.

## Decision

One global sequence, `policy_version_seq`, feeds every version (B5). Triggers take a new value on
`companies.policy_version` for company-wide changes, on `employee_monitoring_settings.policy_version`
for settings and pauses. `devices.policy_version` takes a value when the binding is made and never
changes, because a binding's employee is fixed (D48; 0003 drops `devices_policy_bump`). A device's
version is `greatest(company, employee settings, device)`, so it only grows.

Example: a device bound to employee A has company 105, A 230, device 40, so its version is 230.
An admin turns off A's window titles: A becomes 231, the device 231. An admin then adds a block
rule: the company becomes 232, the device 232. With a counter per scope the company would have gone
from 105 to 106, below A's 231, and the block rule would never have reached the agent early. There is no `policy_versions` table. The `ETag` is a hash of the resolved response
body, not the version. `update_package_url` in that body is signed once per release per UTC day and
valid to the end of the next day (B16), so the body, and with it the ETag, is stable within a day.

## Consequences

No table to keep in step and no code path that must remember to bump: the triggers do it. The
version only grows, so an agent comparing with `>` is always right. Any byte change in the body
changes the ETag, so a missed bump cannot hide a change from `304`. The cost: every device of a
company refetches when anything company-wide changes; versions are not dense per company and say
nothing about what changed; and the ETag changes once a day per release even when nothing else did.

## Alternatives considered

| Option | Why not |
|---|---|
| `policy_versions` table (Plan §6.2) | A second write per change that can be missed; per-scope counters can hide a change behind a larger one |
| Version per company and per employee, summed or paired | Paired: the greatest hides a change in the smaller; summed: works, but needs both counters kept and offers nothing over one sequence |
| ETag from the version | A body change without a bump (a bug, a re-signed URL) would still answer `304` |
| Sign `update_package_url` per request | The body, and so the ETag, would change every time; `304` would never happen |

## Links

- Decisions: [B5, B16](../backend-decisions.md), D8, D31, D37, D48, Plan-v3.5 §6.2, Q13.
- Design: [distribute-agents design](../../openspec/changes/distribute-agents/design.md).
- Schema: [0001_init.sql](../../../db/migrations/0001_init.sql) `policy_version_seq` and the `*_policy_bump` triggers;
  [0003_device_binding.sql](../../../db/migrations/0003_device_binding.sql) drops `devices_policy_bump`.
- Specs: [agent-policy](../../openspec/changes/serve-agent-policy/specs/agent-policy/spec.md),
  [heartbeat](../../openspec/changes/receive-device-health/specs/heartbeat/spec.md),
  [agent-updates](../../openspec/changes/distribute-agents/specs/agent-updates/spec.md),
  [monitoring-settings](../../openspec/changes/manage-employees/specs/monitoring-settings/spec.md).
