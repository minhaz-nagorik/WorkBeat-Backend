# ADR 0010 — The agent contract is owned here

**Status:** Accepted
**Date:** 2026-11-15

## Context

The Mac and Windows agents and the Downloader live in their own repositories and specify the
client side: what they send and how they react to every HTTP status and `code`. Each agent repo
says the API's published contract is the authority for payload shapes and leaves that open (their
open question Q1). The agent repos were written before Plan v3.5 D43 to D48 and still describe
portal tokens, `--token`, an optional employee, an unassigned queue and
`ENROLLMENT_TOKEN_REVOKED` (Q16). Plan §3 makes `packages/shared` the single source of truth for
API contracts.

## Decision

This repository owns the error envelope, the `code` catalog and every payload schema the agents
and the Downloader consume (B9). [agent-contract.md](../../core/api/agent-contract.md) summarises
routes, fields and the status table; exact zod schemas and constants (intervals, limits, the
browser list) live in `packages/shared`, which the agents' contract tests and the web platform
consume. Every response is `{ "data": … }` or `{ "error": …, "code": … }` with `Date` and
`X-Request-Id` headers; clients branch on status and `code`, never on `error`. A route, field,
status or `code` the agents rely on changes only through a spec change here and in both agent
repositories (CLAUDE.md rule 5). Where Plan v3.5 changed the contract (D43–D48), the backend
follows the plan and the agent repositories are behind; that gap is tracked as Q16, not worked
around in the API.

## Consequences

Agents get one place to read the contract and one package to test against; Q1 has an answer once
both agent owners sign off. Specs here cite the agent spec or agent-contract.md wherever a
requirement exists because a client relies on it. The cost: a contract change needs three
repositories to move together; until Q16 is closed the agent specs describe behaviour the API
will not provide (portal tokens, unassigned enrollment), and an agent built to them fails at
enrollment.

## Alternatives considered

| Option | Why not |
|---|---|
| Each agent repo defines its own wire types | Two copies drift; Plan §3 names `packages/shared` as the source |
| OpenAPI generated from the NestJS code | The code would define the contract after the fact; specs come first (ADR 0001) |
| Follow the agent specs where they predate D43–D48 | Plan v3.5 outranks them (config.yaml "Source authority") |

## Rejected explicitly

Returning `ENROLLMENT_TOKEN_REVOKED`, or accepting portal tokens, to match the older agent specs.

## Links

- Decisions: [B9](../backend-decisions.md), D43–D48, Plan-v3.5 §3, Q1 and Q16 in
  [open-questions.md](../open-questions.md).
- Contract: [agent-contract.md](../../core/api/agent-contract.md).
- Design: [enroll-devices](../../openspec/changes/enroll-devices/design.md).
- Specs: [api-envelope](../../openspec/changes/establish-api-foundation/specs/api-envelope/spec.md),
  [device-authentication](../../openspec/changes/enroll-devices/specs/device-authentication/spec.md),
  [heartbeat](../../openspec/changes/receive-device-health/specs/heartbeat/spec.md),
  [agent-policy](../../openspec/changes/serve-agent-policy/specs/agent-policy/spec.md),
  [activity-ingestion](../../openspec/changes/ingest-activity/specs/activity-ingestion/spec.md).
