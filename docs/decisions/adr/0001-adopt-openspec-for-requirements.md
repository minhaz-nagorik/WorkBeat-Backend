# ADR 0001 — Adopt OpenSpec for requirements

**Status:** Accepted
**Date:** 2026-11-15

## Context

Four sources describe the backend and they do not agree everywhere: WorkBeat Plan v3.5, this
repository's B-numbers, the PRD, and the two agent repositories' specs (which are behind D43 to
D48). The API is multi-tenant and holds employee monitoring data, so an unstated behaviour is a
tenant leak or a privacy gap, not just a missing feature. Two agents, a Downloader and the web
platform consume this API from other repositories, and each needs one place where the server's
behaviour is stated testably.

## Decision

Backend requirements live in `docs/openspec/` as OpenSpec changes. Each change has a proposal,
tasks, a design where an upstream clause is amended, and one `spec.md` per capability, written as
SHALL / MUST statements with WHEN/THEN scenarios and a `<!-- source: … -->` comment naming the D,
B, Plan or PRD clause behind each requirement (`docs/openspec/config.yaml`). A behaviour change
starts as a spec change before any code. `openspec validate --all --strict`, run from `docs/`, is
a merge gate. Docs elsewhere in `docs/` explain and never state a requirement. Plan v3.5 is the
source of truth; where a design amends an upstream clause it records which one and why the newer
rule wins.

## Consequences

Every behaviour has an address a test can cite, and every requirement has a traceable source.
The precedence order in `config.yaml` settles most disagreements without a meeting. Writing the
spec costs time before the first line of TypeScript, and changing a behaviour means a spec change,
not just a commit. A change the agents rely on also needs a spec change in both agent repositories
(ADR 0010).

## Alternatives considered

| Option | Why not |
|---|---|
| Work from the plan and PRD directly | Two documents that disagree; no traceability from a test to a clause |
| Requirements in GitHub issues | Not versioned with the code; no validation |
| Specs in code comments or OpenAPI only | Says what a route accepts, not who may call it, what rows it writes or which tenant it sees |

## Links

- Decisions: CLAUDE.md rule 10; Plan-v3.5 §7 ("a behaviour change starts as a spec change").
- Config: [`docs/openspec/config.yaml`](../../openspec/config.yaml).
- Same decision in the agent repositories: their ADR 0001.
