# Architecture Decision Records

Why the backend is built the way it is. Rulings themselves are B-numbers in
[backend-decisions.md](../backend-decisions.md) and D-numbers in Plan v3.5; requirements are in
`docs/openspec/`. An ADR explains a choice and the options it beat. New ADRs copy
[0000-template.md](0000-template.md) and take the next number.

| # | Title | Status | Summary |
|---|---|---|---|
| [0001](0001-adopt-openspec-for-requirements.md) | Adopt OpenSpec for requirements | Accepted | Spec before code; `openspec validate --all --strict` is a merge gate |
| [0002](0002-nestjs-fastify-api-over-supabase.md) | Build one NestJS API on Fastify over Supabase | Accepted | One container API for every client; web platform in its own repo (B1) |
| [0003](0003-one-scoped-transaction-per-request.md) | Run every request in one scoped transaction | Accepted | `SET LOCAL` scope and company per request; RLS as backstop, no bypass (B2, B15) |
| [0004](0004-credentials-resolved-through-security-definer-lookups.md) | Resolve credentials through SECURITY DEFINER lookups | Accepted | Narrow hash lookups before a tenant is known; narrow staff helpers (B3) |
| [0005](0005-seats-counted-and-enforced-in-the-database.md) | Count seats from devices and enforce the limit in the database | Accepted | No stored count; a trigger locks the licence row and refuses the extra device (B4, D43) |
| [0006](0006-one-global-sequence-for-policy-versions.md) | One global sequence for policy versions | Accepted | Versions only grow, so a change in any scope shows; ETag is the body hash (B5, B16) |
| [0007](0007-licence-key-is-the-only-install-credential.md) | The licence key is the only install credential | Accepted | Two-step validate; single-use 24 h token bound to the employee (D43, D47, B8) |
| [0008](0008-monthly-partitions-without-foreign-keys-for-activity.md) | Monthly partitions without foreign keys for activity | Accepted | Cheap ingest, idempotent batches, time window and batched retention (B7, B13, B15) |
| [0009](0009-scheduled-work-only-through-cron-routes.md) | Run scheduled work only through cron routes | Accepted | Scheduler-called `/cron/*` with a shared secret, system scope, advisory locks (B10) |
| [0010](0010-the-agent-contract-is-owned-here.md) | The agent contract is owned here | Accepted | Envelope, codes and zod schemas live here; agent repos are behind D43–D48 (B9, Q16) |
