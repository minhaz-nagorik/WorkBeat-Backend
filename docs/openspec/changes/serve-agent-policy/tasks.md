> **Read first — this task list is not the requirement.**
> Capabilities: `agent-policy · block-rules · sensitive-domains · productivity-rules · collection-notice`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show serve-agent-policy`.
> Contract: [agent-contract.md](../../../core/api/agent-contract.md) · Schema: [data-model.md](../../../core/architecture/data-model.md).

## 1. agent-policy

- [ ] 1.1 Policy response zod schema in `packages/shared`, exactly the agent-contract.md "Policy response" fields
- [ ] 1.2 `GET /v1/agents/policy` behind the device-key guard: one query for company, employee settings, device, rules, sensitive domains, open pauses
- [ ] 1.3 `min_agent_version` = max(company, newest non-withdrawn `agent` release `min_supported` for the device `os`), compared as semantic versions
- [ ] 1.4 `ETag` = hash of the serialised body; `If-None-Match` match → `304`
- [ ] 1.5 Tests: every field present and typed; two employees get their own switches and pauses; cancelled and ended pauses absent; `policy_version` = greatest of three and grows on reassignment; 304 on match, 200 after a rule change; tenant isolation — a device never receives another company's rules or another employee's pauses
- [ ] 1.6 Read the version and the body in one snapshot (one statement or a `REPEATABLE READ` transaction)
- [ ] 1.7 Edge tests: no rules → empty arrays, never null; suspended → 402 and no `ETag`; pause in force and future pause both listed; pause ending now absent; tier `off` → interval 0; reassignment switches settings and pauses; withdrawn newest release ignored for `min_agent_version`; company B's rule never in A's policy; rule add raises every device's version; stale `If-None-Match` → 200 with current `ETag`; next UTC day → one 200 then 304; rule added mid-fetch → old version + old body or new + new

## 2. block-rules

- [ ] 2.1 `GET/POST /v1/block-rules`, `PATCH/DELETE /v1/block-rules/:id`; unique violation → `409 CONFLICT`
- [ ] 2.2 Validators: host name for `domain`; Chrome URLBlocklist filter grammar for `url`
- [ ] 2.3 Regex compiler for the accepted prefix forms (literal host, `(www\.)?`, host alternation, literal path, trailing `.*`); everything else → 422
- [ ] 2.4 Tests: role matrix (company_admin, it_admin write; manager read); invalid domain/url → 422; regex compiled and refused cases; `companies.policy_version` rises on each write; tenant isolation — another company's rule ID → 404 and never listed
- [ ] 2.5 Edge tests: case-only duplicate → 409; same pattern as `domain` and `url` → both 201; concurrent identical creates → one 201, one 409; patch into a duplicate → 409; upper case stored lower; IP → 422; patch breaking the type → 422; `url` over 2,048 chars → 422; regex compiling onto an existing rule → 409 and nothing written; deleted twice → 404

## 3. sensitive-domains

- [ ] 3.1 `GET/POST /v1/sensitive-domains`, `DELETE /v1/sensitive-domains/:id`; host-name validator shared with block rules
- [ ] 3.2 Tests: company_admin writes, manager reads, it_admin 403; defaults removable; wildcard → 422; duplicate → 409; `policy_version` rises; tenant isolation — another company's entries never listed or deletable
- [ ] 3.3 Edge tests: case-only duplicate → 409; manager reads, manager write → 403; removed default re-added → `is_default` false; all removed → `sensitive_domains` []; 253 chars → 201, 254 → 422; another company's ID → 404

## 4. productivity-rules

- [ ] 4.1 `GET/POST /v1/productivity-rules`, `PATCH/DELETE /v1/productivity-rules/:id`
- [ ] 4.2 Tests: company_admin writes, manager reads, it_admin 403; invalid category → 422; duplicate → 409; no `policy_version` change; tenant isolation — another company's rules never listed
- [ ] 4.3 Edge tests: manager write → 403; case-only duplicate → 409; same pattern as `app` and `domain` → 201; empty `app` pattern → 422; another company's ID → 404

## 5. collection-notice

- [ ] 5.1 `GET/PUT /v1/settings/notice`; `notice_version + 1` only when the text differs, in the same update
- [ ] 5.2 Tests: company_admin only, other roles 403; empty and oversized text → 422; same text → no version change; policy carries `{ text, version }`; tenant isolation — the notice read is the caller's company's
- [ ] 5.3 Edge tests: whitespace-only → 422; text at the limit saved, one over → 422; manager → 403; two concurrent different saves → version + 2; each company's policy carries its own notice
