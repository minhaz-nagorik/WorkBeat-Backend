## Why

Every agent enforces and collects exactly what `GET /v1/agents/policy` tells it (D8): block rules of
type `domain` or `url` only (D39), sensitive domains (D4), the idle threshold (D15), the uninstall
token hash (D19), the collection notice (D25), and, per device's employee, the feature switches,
screenshot interval and pauses (D37, D31). The version is the greatest of company, employee and
device (B5) and is fetched with an ETag every 30 minutes. Admins need the rules behind it:
block list and productivity rules (Plan-v3.2 §4.4 "Monitoring policy", PRD "Permission matrix").

## What Changes

- **Agent policy**: one resolved body per device, `policy_version` per B5, `ETag` and `304`.
- **Block rules**: `domain` and `url` (Chrome URLBlocklist filter) rules; regex input compiled to
  `url` patterns or refused with `422 VALIDATION_FAILED` (D39).
- **Sensitive domains**: list, add and remove, defaults included (D4).
- **Productivity rules**: `app` / `domain` → category, resolved at report time (PRD).
- **Collection notice**: edit the text; the version and the policy version rise (D25).

## Capabilities

### New Capabilities

- `agent-policy`: `GET /v1/agents/policy`, its fields, version and ETag.
- `block-rules`: block-list routes, pattern validation and regex compilation.
- `sensitive-domains`: sensitive-domain routes.
- `productivity-rules`: productivity-rule routes.
- `collection-notice`: notice text and version.

### Modified Capabilities

None.

## Impact

- Routes: `GET /v1/agents/policy`; `GET/POST /v1/block-rules`, `PATCH/DELETE /v1/block-rules/:id`;
  `GET/POST /v1/sensitive-domains`, `DELETE /v1/sensitive-domains/:id`;
  `GET/POST /v1/productivity-rules`, `PATCH/DELETE /v1/productivity-rules/:id`;
  `GET/PUT /v1/settings/notice`.
- Consumed by both agents: Mac `report-device-health` `policy-refresh`, `monitoring-features`,
  `monitoring-pause`; `track-and-block-websites` `browser-url-blocking`, `system-blocking`,
  `sensitive-domain-exclusion`; `policy-model.md`.
- Depends on `enroll-devices` (`device-authentication`) and `manage-employees` (settings, pauses).
  `update_package_url` / `update_package_sha256` are filled by `distribute-agents`
  `agent-updates`; the idle threshold is edited in `configure-company` and the minimum version in `distribute-agents`; defaults
  are seeded at signup by `provision-companies`; productivity is applied by `report-usage`.
- Schema: `block_rules`, `sensitive_domains`, `productivity_rules`, `companies` notice columns and
  the `*_policy_bump` triggers in `0001_init.sql`.
