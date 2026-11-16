# ADR 0007 — The licence key is the only install credential

**Status:** Accepted
**Date:** 2026-11-15
**Amends:** the agent repositories' portal-made enrollment tokens and single-call validation
(see the enroll-devices design); Plan v3.5 D43 and D47 are newer and win.

## Context

Before Plan v3.5, IT created enrollment tokens in the portal (name, expiry, use limit), the
Downloader accepted a token or a key, and a device could enroll with no employee. D43 removes
install tokens: IT installs every device with the company's licence key, and the Downloader
exchanges it for a token only the agent sees. D47 makes the employee required: the Downloader will
not install until one is picked, and there is no unassigned queue. The portal must still show and
copy the licence key and the uninstall token (prototype), while every other secret must be
unrecoverable from a database read.

## Decision

`POST /license/validate` accepts only `X-License-Key` and has two steps (B8). Step 1, without
`employee_id`, returns `company_name` and the active employee list. Step 2, with `employee_id`,
also returns a single-use enrollment token valid for 24 hours, bound to that employee
(`enrollment_tokens.employee_id NOT NULL`), plus the package URL and SHA-256. Both steps check
suspension, expiry and a free seat; neither reserves one (ADR 0005). `POST /devices/enroll`
assigns the device to the token's employee; a different `employee_id` in the body gets
`422 VALIDATION_FAILED`. No route creates, lists or revokes a token. A key reissue deletes the
licence's unused tokens, which then answer `404 ENROLLMENT_TOKEN_INVALID`;
`ENROLLMENT_TOKEN_REVOKED` is never returned. `/cron/token-expiry` deletes expired unused tokens.
Secrets are stored as SHA-256 for lookup; the licence key and the uninstall token are also stored
as AES-256-GCM ciphertext with a key from the environment, for display (B6). Device keys,
enrollment tokens and invitation tokens are hash-only. None is ever logged.

## Consequences

IT handles one secret per company. A tampered agent config cannot move a device to another
employee, because the employee comes from the token. A leaked token is worth one install for one
named employee for at most a day; a leaked key is stopped by a reissue that leaves every device and
seat in place (D43). The cost: the agent repositories are behind and must drop portal tokens,
`--token` and the unassigned path (Q16, ADR 0010); a lost encryption key makes the stored licence
keys and uninstall tokens unreadable until reissued; and two Downloaders can both validate for the
last seat, so the second learns of it only at enrollment (`403 SEAT_LIMIT_EXCEEDED`).

## Alternatives considered

| Option | Why not |
|---|---|
| Keep portal tokens beside the key | D43 removed them; two install credentials to revoke and support |
| One-call validate returning a token | Cannot bind the token to an employee the user has not picked yet (D47) |
| Optional employee with an unassigned queue | D47: every device has an employee; the seat is filled for that employee |
| Licence key hash-only | The portal must show and copy it (B6) |
| Licence key in plaintext | A database read would leak a working install credential |

## Links

- Decisions: [B6, B8](../backend-decisions.md), D26, D43, D47, Plan-v3.5 §5.3, Q16.
- Design: [enroll-devices design](../../openspec/changes/enroll-devices/design.md).
- Specs: [license-validation](../../openspec/changes/enroll-devices/specs/license-validation/spec.md),
  [device-enrollment](../../openspec/changes/enroll-devices/specs/device-enrollment/spec.md),
  [license-key](../../openspec/changes/provision-companies/specs/license-key/spec.md),
  [staff-license-reissue](../../openspec/changes/administer-platform/specs/staff-license-reissue/spec.md),
  [cron-routes](../../openspec/changes/run-scheduled-jobs/specs/cron-routes/spec.md).
