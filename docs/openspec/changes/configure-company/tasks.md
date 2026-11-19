> **Read first — this task list is not the requirement.**
> Capabilities: `company-settings · custom-domains`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show configure-company`.
> Contract: [agent-contract.md](../../../core/api/agent-contract.md) · Schema: [data-model.md](../../../core/architecture/data-model.md).

## 1. company-settings

- [ ] 1.1 `GET /v1/company/settings` and `PATCH /v1/company/settings` with zod schemas in `packages/shared` (alert types = tamper `event_type` values)
- [ ] 1.2 `GET /v1/company/setup` and `POST /v1/company/setup/steps`; step names in `packages/shared`
- [ ] 1.3 Tests: retention 45, 180 and 365 → 422; idle threshold change bumps `companies.policy_version`; unknown alert role → 422; `install_first_device` and `first_device_seen` follow device rows; manager → 403; tenant isolation: company A's settings and checklist never reflect company B's devices or values
- [ ] 1.4 Bump `companies.policy_version` only when `idle_threshold_seconds` actually changes; step marking with `array_append` guarded by `NOT (step = ANY(...))`
- [ ] 1.5 Tests (edge cases): name 100 → ok, 101 or blank → 422; `slug` in body ignored; retention 30/60/90 ok, 0, 45 and 30.5 → 422; lowering 90 → 30 deletes nothing in the request; idle 60/3600 ok, 59/3601 → 422; same idle value → no bump; empty `roles` saved; `super_admin` role → 422; step twice stored once; derived or unknown step → 422; released first device keeps both steps done; timezone change re-days past reports; `Europe/London` DST day is 23 h

## 2. custom-domains

- [ ] 2.1 `GET`, `PUT`, `DELETE /v1/company/custom-domain`; hostname validation; random token
- [ ] 2.2 `/cron/domain-verify` handler: TXT lookup with a short timeout per domain, batch of pending domains, failure cut-off constant in `packages/shared`
- [ ] 2.3 `GET /v1/hosts/resolve` through `company_by_host`
- [ ] 2.4 Tests: taken domain → 409; `*.workbeat.io` → 422; TXT match → `active`; no match → still `pending` with `custom_domain_checked_at`; past the cut-off → `failed`; DNS timeout leaves the row unchanged; a `pending` domain does not resolve; tenant isolation: the job's update of one company never changes another's row
- [ ] 2.5 Normalise the domain (lower case, strip trailing dot) before the uniqueness check; PUT of the current domain is a no-op; failed domains cleared once `custom_domain_checked_at` is older than the release period in `packages/shared`
- [x] 2.6 Fixed in `db/migrations/0002_spec_gaps.sql`: `company_by_host` matches `x.acme-ltd.workbeat.io` to slug `x`; it must resolve only a single label before `.workbeat.io`
- [ ] 2.7 Tests (edge cases): another company's active domain → 409, theirs unchanged; concurrent claims → one pending, one 409; own domain again unchanged; trailing dot stored without it; `WORKBEAT.IO` → 422; one of several TXT values matches; stale token stays pending; active domain never re-checked (flapping); resolver down → all unchanged, 200; deeper workbeat.io sub-domain → 404; suspended company host resolves; upper-case host resolves; failed domain released after the period and claimable by another company; still shown within the period
