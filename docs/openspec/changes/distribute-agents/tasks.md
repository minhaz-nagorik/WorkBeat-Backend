> **Read first — this task list is not the requirement.**
> Capabilities: `agent-releases · installer-downloads · agent-updates`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show distribute-agents`.
> Contract: [agent-contract.md](../../../core/api/agent-contract.md) · Schema: [data-model.md](../../../core/architecture/data-model.md).

## 1. agent-releases

- [ ] 1.1 Private bucket `agents`; release zod schema in `packages/shared` (`x.y.z`, platform/arch pairs, SHA-256 hex)
- [ ] 1.2 `POST /v1/staff/agent-releases` (object stat and size check), `POST /v1/staff/agent-releases/:id/withdraw`, `GET /v1/staff/agent-releases`, in `staff` scope
- [ ] 1.3 Numeric semver helper in `packages/shared`; global and effective minimum queries
- [ ] 1.4 Publish and withdraw bump every `companies.policy_version`
- [ ] 1.5 Tests: company user → 403; `windows` `universal` → 422; duplicate → 409; withdrawn release not offered; 1.0.10 > 1.0.9
- [ ] 1.6 Tests (edge cases): size mismatch → 422, no row; concurrent same-tuple publish → one 201, one 409; republishing a withdrawn version → 409; `1.0` / `1.0.5-beta` → 422; withdrawing the only `windows` `arm64` release → null update fields and no download entry; it_admin withdraw → 403; older version published later does not become newest; withdrawing the newest recomputes the global minimum; 1.0.10 newest over 1.0.9; no release and no company floor → no `outdated`; Downloader publish/withdraw bumps no `policy_version`

## 2. installer-downloads

- [ ] 2.1 `GET /v1/downloads` for `company_admin` and `it_admin`: newest live Downloader per platform, agent per platform and arch, signed URLs
- [ ] 2.2 Tests: manager and staff → 403; missing platform left out; logs hold no URL
- [ ] 2.3 Tests (edge cases): suspended company still gets links; link refused at `expires_at`; all releases withdrawn → 200 empty list

## 3. agent-updates

- [ ] 3.1 Update field resolver for `agent-policy`: release by `os` + arch (`universal` for macOS), URL signed once per UTC day, valid to the end of the next day
- [ ] 3.2 Cache the day's signed URL per release so the policy body, and its ETag, are stable within a day
- [ ] 3.3 `PUT /v1/deployment/min-agent-version` for `company_admin` and `it_admin`
- [ ] 3.4 Tests: arm64 PC gets the arm64 MSI; Intel Mac gets the universal `.pkg`; no release → nulls; 30-hour-old ETag → 200; released device → 401; tenant isolation: one company's minimum never changes another's policy
- [ ] 3.5 Tests (edge cases): withdrawn newest falls back to older live; URL changes at UTC midnight and the old one stays valid to the end of the new day; two instances same day → same URL and ETag (deterministic or shared per-day cache); null company floor → global; floor above the newest live release → 422; company A floor leaves B unchanged; deactivated device → 401 `DEVICE_REVOKED`
