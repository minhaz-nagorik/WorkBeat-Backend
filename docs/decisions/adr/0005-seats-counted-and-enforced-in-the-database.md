# ADR 0005 — Count seats from devices and enforce the limit in the database

**Status:** Accepted
**Date:** 2026-11-15

## Context

A company pays per seat. Seats belong to the company, not to the licence key: releasing or
deactivating a device frees its seat for the next install, and reissuing the key changes only the
key, keeping every device and seat (D43). A seat is filled only when the agent enrolls for a picked
employee, never at validation (D44, Plan-v3.2 §5.3). Two Downloaders can pass validation for the
last seat at the same moment, and their enrollments can land on two API instances.

## Decision

Seats used are never stored. They are counted from `devices` where `deactivated_at` and
`released_at` are both NULL (partial index `devices_seat`) (B4). The `devices_seat` trigger runs
before a device is inserted, or updated in `deactivated_at` / `released_at`, whenever the row
starts holding a seat: it locks the company's `licenses` row `FOR UPDATE`, counts the other
seat-holding devices, and raises `SEAT_LIMIT_EXCEEDED` when the count has reached `seat_limit`
(NULL = unlimited, Enterprise). The API maps that to `403 SEAT_LIMIT_EXCEEDED`.
`/license/validate` checks for a free seat but reserves nothing. A key reissue writes only the key
columns, so devices and the count are untouched. Staff see the count through
`company_seat_counts()` (ADR 0004).

## Consequences

The count cannot drift: there is nothing to keep in step. Two enrollments racing for the last seat
serialise on the licence row lock; one wins, the other gets `403`, which the agent already retries
each policy interval. No API code path can forget the check, including a future one. Release,
deactivation and the uninstaller's deactivate (B17) free a seat with no extra write. The cost:
every enrollment and every un-release takes a row lock on the company's licence, which serialises
a mass rollout per company, and a count over that company's devices; a seat error surfaces as a
database exception the API must translate.

## Alternatives considered

| Option | Why not |
|---|---|
| A `seats_used` counter column on `licenses` | Drifts on any missed increment or decrement, and on a reissue that copies or resets it (D43) |
| Check in the API only, before insert | Two instances both see a free seat and both insert |
| Reserve a seat at `/license/validate` | A failed or abandoned install would hold a seat; Plan §5.3 says validation reserves nothing |
| Seats on the key row | A reissue would move or lose them (D43) |

## Rejected explicitly

Storing seats used anywhere (CLAUDE.md rule 7).

## Links

- Decisions: [B4, B8, B17](../backend-decisions.md), D43, D44, Plan-v3.2 §5.3.
- Schema: [0001_init.sql](../../../db/migrations/0001_init.sql) `devices_seat_check`.
- Specs: [device-enrollment](../../openspec/changes/enroll-devices/specs/device-enrollment/spec.md),
  [license-validation](../../openspec/changes/enroll-devices/specs/license-validation/spec.md),
  [device-lifecycle](../../openspec/changes/enroll-devices/specs/device-lifecycle/spec.md),
  [license-key](../../openspec/changes/provision-companies/specs/license-key/spec.md),
  [staff-license-reissue](../../openspec/changes/administer-platform/specs/staff-license-reissue/spec.md).
