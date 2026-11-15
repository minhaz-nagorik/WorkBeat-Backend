# ADR 0006 — One global sequence for policy versions

**Status:** Accepted
**Date:** 2026-11-15
**Amends:** Plan-v3.2 §6.2 `policy_versions` table (company and employee scope, version,
updated_at). Open question Q13 asks the plan owner to edit the plan.

## Context

Each device fetches policy every 30 minutes with an ETag and gets `304` when nothing changed (D8).
Its heartbeat carries `policy_version` so a change can trigger an early fetch. A device's policy
mixes company fields (block rules, sensitive domains, notice, idle threshold, minimum version,
uninstall token hash), its employee's settings and pauses (D31, D37), and which employee it
belongs to. A device can be reassigned to another employee (D44); if versions were counted per
company or per employee, the new employee's version could be lower than the old one and the agent
would never notice the change.

## Decision

One global sequence, `policy_version_seq`, feeds every version (B5). Triggers take a new value on
`companies.policy_version` for company-wide changes, on `employee_monitoring_settings.policy_version`
for settings and pauses, and on `devices.policy_version` when a device's employee changes. A
device's version is `greatest(company, employee settings, device)`, so it only grows, including on
reassignment. There is no `policy_versions` table. The `ETag` is a hash of the resolved response
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
| `policy_versions` table (Plan §6.2) | A second write per change that can be missed; per-scope counters can go down on reassignment |
| Version per company and per employee, summed or paired | Reassignment can still produce a smaller value |
| ETag from the version | A body change without a bump (a bug, a re-signed URL) would still answer `304` |
| Sign `update_package_url` per request | The body, and so the ETag, would change every time; `304` would never happen |

## Links

- Decisions: [B5, B16](../backend-decisions.md), D8, D31, D37, D44, Plan-v3.2 §6.2, Q13.
- Design: [distribute-agents design](../../openspec/changes/distribute-agents/design.md).
- Schema: [0001_init.sql](../../../db/migrations/0001_init.sql) `policy_version_seq` and the `*_policy_bump` triggers.
- Specs: [agent-policy](../../openspec/changes/serve-agent-policy/specs/agent-policy/spec.md),
  [heartbeat](../../openspec/changes/receive-device-health/specs/heartbeat/spec.md),
  [agent-updates](../../openspec/changes/distribute-agents/specs/agent-updates/spec.md),
  [monitoring-settings](../../openspec/changes/manage-employees/specs/monitoring-settings/spec.md).
