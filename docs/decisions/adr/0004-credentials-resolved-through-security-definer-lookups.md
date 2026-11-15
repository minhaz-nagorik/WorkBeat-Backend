# ADR 0004 — Resolve credentials through SECURITY DEFINER lookups

**Status:** Accepted
**Date:** 2026-11-15

## Context

Under ADR 0003 a transaction sees no tenant rows until `app.company_id` is set, but the company is
only known after the credential is checked. A device key, licence key, enrollment token,
invitation token, host name or Stripe customer ID arrives with no tenant. Staff in `staff` scope
also need two facts that live in tenant tables (seat counts, unused tokens) without being able to
read those tables (D41). The tempting fix, a second connection that bypasses RLS, would undo
ADR 0003 on exactly the paths that face the internet.

## Decision

Before a tenant is known, the API resolves a credential only through `SECURITY DEFINER` functions
owned by the schema owner, executable only by `workbeat_api`, each returning the few columns its
guard needs: `auth_device`, `auth_license`, `auth_enrollment_token` (returns `used` and `expired`
since 0002), `auth_invitation`, `company_by_host`, and `company_by_stripe_customer` (B3). Each
takes a SHA-256 hash, never the secret, because only hashes are stored (B6). The guard then sets
the tenant scope and everything else runs under RLS. Staff get two helpers in 0002 that return
counts or delete only what they must: `company_seat_counts()` returns a number per company, never
the devices behind it, and `delete_unused_enrollment_tokens(license_id)` deletes one licence's
unused tokens on a key reissue. Both refuse outside `staff` or `system` scope.

## Consequences

No request path needs a bypass-RLS connection. Each lookup is small enough to review in full,
and a leak through one exposes an ID and a flag, not a row. A presented secret is hashed once and
compared by index. The cost: every new credential type, and every staff need that touches tenant
data, is a migration that adds a function, not a query in the API; and a function can still be
written too wide, so each one is reviewed against "only what the guard needs".

## Alternatives considered

| Option | Why not |
|---|---|
| A bypass-RLS connection for guards | One more connection that sees every company, on internet-facing paths |
| RLS policies keyed on the presented hash | The hash would need to be a session setting readable by every policy; harder to audit than one function |
| Staff read devices to count seats | Breaks D41: staff never read device rows |
| Store plaintext tokens for lookup | A database read would leak working credentials |

## Links

- Decisions: [B3, B6](../backend-decisions.md), D41, D43.
- Schema: [0001_init.sql](../../../db/migrations/0001_init.sql) "credential lookups",
  [0002_spec_gaps.sql](../../../db/migrations/0002_spec_gaps.sql).
- Specs: [request-scope](../../openspec/changes/establish-api-foundation/specs/request-scope/spec.md),
  [device-authentication](../../openspec/changes/enroll-devices/specs/device-authentication/spec.md),
  [license-validation](../../openspec/changes/enroll-devices/specs/license-validation/spec.md),
  [staff-companies](../../openspec/changes/administer-platform/specs/staff-companies/spec.md),
  [staff-license-reissue](../../openspec/changes/administer-platform/specs/staff-license-reissue/spec.md),
  [custom-domains](../../openspec/changes/configure-company/specs/custom-domains/spec.md).
