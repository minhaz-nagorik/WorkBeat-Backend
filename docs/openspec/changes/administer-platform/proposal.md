## Why

WorkBeat staff run the business from the staff area: they see every company's plan, seats,
tier and status, suspend and restore, set Enterprise limits and the expired-licence grace, and
reissue a leaked licence key (Plan-v3.5 §4.6, D43). They must do all of it without ever seeing an
employee, device, URL or screenshot (D41, PRD "Permission matrix"), and a staff token reading
tenant data is a top risk the plan wants tested in CI (Plan-v3.5 §8).

## What Changes

- **Company list and detail** for staff with plan, seats used and limit, tier, status, domain
  and an MRR estimate; seats come from a count-only function, not from `devices` (B2, B4).
- **Suspend and restore** (`suspended_reason` `staff`), **Enterprise plan and seat-limit
  overrides**, and **`expired_blocking_grace_days`**.
- **Licence key reissue** on the same `licenses` row, deleting unused enrollment tokens and
  emailing company admins; devices and seats unchanged (D43).
- **Staff data boundary**: what staff routes never return, and the CI test that proves it.

## Capabilities

### New Capabilities

- `staff-companies`: the company list, detail, suspend, restore and overrides.
- `staff-license-reissue`: replacing a company's licence key.
- `staff-data-boundary`: what staff never read, and how it is enforced and tested.

### Modified Capabilities

None.

## Impact

- Consumed by the web platform's staff area.
- Depends on `authenticate-users` (staff sign-in, role guard) and `provision-companies` (status,
  licence key format and storage).
- Agents see the reissue only through `enroll-devices`: the old key answers `404
  LICENSE_NOT_FOUND`, deleted tokens `404 ENROLLMENT_TOKEN_INVALID` (agent-contract.md).
- Schema: adds `db/migrations/0002` with `company_seat_counts()` and
  `delete_unused_enrollment_tokens(uuid)`, both `SECURITY DEFINER`, because `staff` scope reads
  neither `devices` nor `enrollment_tokens`.
