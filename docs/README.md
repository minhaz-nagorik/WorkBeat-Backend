# WorkBeat Backend

The server half of WorkBeat: the NestJS API (Fastify, Node 20), its PostgreSQL schema on
Supabase, and the shared contract the agents, the Downloader and the web platform consume.

> **Backend only.** The Mac and Windows agents, the Downloader and the web platform (WorkBeat Admin)
> live in their own repositories and consume this API.

## Start here

| Read | For |
|---|---|
| **[../CLAUDE.md](../CLAUDE.md)** | The ten rules. **Read it first** |
| [BUILD-ORDER.md](BUILD-ORDER.md) | The fourteen OpenSpec changes, in build order |
| [openspec/](openspec/) | The requirements. Run `openspec` commands from `docs/` |
| [engineering/getting-started.md](engineering/getting-started.md) | Set up, apply migrations, run the self-checks, validate specs |

## Documentation map

| Area | Files |
|---|---|
| **API** | [core/api/README.md](core/api/README.md) (conventions, error catalog) · [agent-contract.md](core/api/agent-contract.md) · [portal-api.md](core/api/portal-api.md) · [staff-api.md](core/api/staff-api.md) · [webhooks-and-cron.md](core/api/webhooks-and-cron.md) |
| **Schema** | [core/architecture/data-model.md](core/architecture/data-model.md) · SQL in [`../db/migrations/`](../db/migrations/) · self-checks in [`../db/tests/`](../db/tests/) |
| **Domain** | [glossary](domain/glossary.md) · [company lifecycle](domain/company-lifecycle.md) · [device lifecycle and seats](domain/device-lifecycle-and-seats.md) · [policy resolution](domain/policy-resolution.md) · [tenancy and scopes](domain/tenancy-and-scopes.md) · [health and alerts](domain/health-and-alerts.md) · [ingestion and retention](domain/ingestion-and-retention.md) |
| **Decisions** | [backend-decisions.md](decisions/backend-decisions.md) (B1–B19) · [ADRs](decisions/adr/README.md) (0001–0010) · [open-questions.md](decisions/open-questions.md) |
| **Engineering** | [getting-started](engineering/getting-started.md) · [environments-and-config](engineering/environments-and-config.md) · [testing-strategy](engineering/testing-strategy.md) · [git-workflow](engineering/git-workflow.md) |
| **Operations** | [deployment](operations/deployment.md) · [scheduled-jobs](operations/scheduled-jobs.md) · [security-and-privacy](operations/security-and-privacy.md) |

## Source of truth

WorkBeat Plan v3.2 (15 Nov 2026) governs, with its decisions D1–D44. B-numbers must agree with it.
The PRD is amended by both. Docs explain; only `openspec/` specifies.
