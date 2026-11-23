> **Read first — this task list is not the requirement.**
> Capabilities: `company-settings · custom-domains`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show configure-company`.
> Contract: [agent-contract.md](../../../core/api/agent-contract.md) · Schema: [data-model.md](../../../core/architecture/data-model.md).

## 1. company-settings

- [ ] 1.1 `GET /v1/company/settings` and `PATCH /v1/company/settings` with zod schemas in `packages/shared`
- [ ] 1.2 `GET /v1/company/setup` and `POST /v1/company/setup/steps`; step names in `packages/shared`
- [ ] 1.3 Tests: retention 45, 180 and 365 → 422; idle threshold change bumps `companies.policy_version`; `install_first_device` and `first_device_seen` follow device rows; manager → 403; tenant isolation: company A's settings and checklist never reflect company B's devices or values
- [ ] 1.4 Bump `companies.policy_version` only when `idle_threshold_seconds` actually changes; step marking with `array_append` guarded by `NOT (step = ANY(...))`
- [ ] 1.5 Tests (edge cases): name 100 → ok, 101 or blank → 422; `slug` in body ignored; retention 30/60/90 ok, 0, 45 and 30.5 → 422; lowering 90 → 30 deletes nothing in the request; idle 60/3600 ok, 59/3601 → 422; same idle value → no bump; empty `roles` saved; `super_admin` role → 422; step twice stored once; derived or unknown step → 422; released first device keeps both steps done; timezone change re-days past reports; `Europe/London` DST day is 23 h

## 2. custom-domains

- [x] 2.1 `GET`, `PUT`, `DELETE /v1/company/custom-domain` for `company_admin` (B33); hostname validation; random token
- [x] 2.2 `GET`, `PATCH /v1/staff/companies/:id/custom-domain`: staff read the records, approve (`active`) or reject (`failed`); `domain` must match the current one, else 409
- [x] 2.3 `GET /v1/hosts/resolve` through `company_by_host`
- [ ] 2.4 Smoke tests, written but not yet run (`smoke-portal.ts` round 4): admin sets → pending; same domain keeps the token; `WORKBEAT.IO` → 422; pending does not resolve; staff with a stale domain → 409; approve → resolves; deactivate → 404; company admin on the staff route → 403; delete → 204
- [x] 2.5 Normalise the domain (lower case, strip trailing dot) before the uniqueness check; PUT of the current domain is a no-op
- [x] 2.6 Fixed in `db/migrations/0002_spec_gaps.sql`: `company_by_host` matches `x.acme-ltd.workbeat.io` to slug `x`; it must resolve only a single label before `.workbeat.io`
- [ ] 2.7 Tests (edge cases): another company's active domain → 409, theirs unchanged; concurrent claims → one pending, one 409; member with a custom role → 403; replacing an active domain stops it resolving; suspended company host resolves
- [x] 2.8 B29: `PATCH /v1/company/settings` refuses `name` and `data_retention_days` with `403` naming them, before any write (the custom domain moved to the company admin in B33)

## 3. Before launch (not needed for local testing)

Local testing runs over plain http with a hosts-file entry. A real customer domain needs all of these first.

- [ ] 3.1 TLS for every customer domain (Q15). Pick who issues and renews a certificate per domain; recommended: the console's host (Vercel project domains API or Cloudflare for SaaS custom hostnames), registered when staff approve and removed when the domain is rejected, deactivated, replaced or deleted
- [ ] 3.2 Make `proxy.workbeat.io` (the `cname_target`) exist and route to the console
- [ ] 3.3 Staff approve a domain only once its certificate is valid; until then the browser shows a full-page "connection is not private" warning and sign-in can fail
- [ ] 3.4 Staff runbook for the manual check: `dig +short TXT _workbeat.<domain>` must show the `txt_value`, and the CNAME must point at `proxy.workbeat.io`
- [ ] 3.5 If the host's API checks domain ownership itself, decide whether it replaces the manual TXT check
