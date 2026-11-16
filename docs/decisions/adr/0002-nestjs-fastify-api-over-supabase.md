# ADR 0002 — Build one NestJS API on Fastify over Supabase

**Status:** Accepted
**Date:** 2026-11-15

## Context

One server serves the web platform (WorkBeat Admin, every role), both agents and the Downloader
(Plan-v3.5 §2.1). It owns tenancy, RBAC, seats, ingestion, reports, Stripe and cron routes. Plan
v2 and v3 fix the stack (Plan-v3.5 §3): NestJS on Node 20 with the Fastify adapter, Supabase
PostgreSQL through the Supavisor pooler in transaction mode, Supabase Auth (one project for
company users and staff, D41), Supabase Storage with private buckets, Resend, Stripe. The web
platform is Next.js on Vercel. Plan §6.5 draws one monorepo with `apps/api` and `apps/admin`,
but the agents already live in their own repositories.

## Decision

The backend is a NestJS (Node 20 LTS) API on the Fastify adapter, deployed as a container, with
all business logic in it. This repository holds `apps/api`, `packages/shared` (the zod contract
and constants) and `db/` (numbered SQL migrations and their self-checks). The web platform is its
own repository and consumes `packages/shared` like the agents do (B1). Next.js route handlers and
server actions do not hold business logic; server components call the API with the user's token.

## Consequences

Agents, Downloader and web platform reach the same rules through one API, so tenancy, seats and
idempotency are enforced in one place. Fastify gives the request rate Plan §6.3 sizes for (about
555 requests per second at 100,000 employees) on a small fleet. NestJS guards map directly onto
the credential, role and tenant checks. The cost: two deploys (container and Vercel) instead of
one, `packages/shared` must be published for the web repository to consume, and a change that
spans API and UI is two pull requests.

## Alternatives considered

| Option | Why not |
|---|---|
| Next.js API routes as the backend | Serverless functions per request fight the transaction-mode pooler and one-transaction-per-request (ADR 0003); agent traffic would scale with the web deploy; Plan §2.1 puts the API in a container |
| Supabase PostgREST / Edge Functions as the API | Tenancy would rest on RLS with JWT claims alone, and devices carry no JWT; `anon` and `authenticated` get no table access (0001_init.sql) |
| Express adapter | Slower per request at the same cost; nothing in the plan needs Express middleware |
| One monorepo with `apps/admin` (Plan §6.5 as drawn) | The agents already left it; the web platform follows them, and the contract is shared as a package (B1) |

## Rejected explicitly

An in-process NestJS scheduler: it runs once per instance (Plan §3; ADR 0009).

## Links

- Decisions: [B1](../backend-decisions.md), D41, Plan-v3.5 §2.1, §3, §6.3, §6.5.
- Specs: [api-envelope](../../openspec/changes/establish-api-foundation/specs/api-envelope/spec.md),
  [request-scope](../../openspec/changes/establish-api-foundation/specs/request-scope/spec.md),
  [user-authentication](../../openspec/changes/authenticate-users/specs/user-authentication/spec.md).
