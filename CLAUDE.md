# CLAUDE.md — the ten rules

WorkBeat backend: the NestJS API (Fastify adapter, Node 20), its PostgreSQL schema on Supabase, and
the shared contract the agents and the web platform consume. These rules are cheap to break and
expensive to discover. **Every diff is bound by them.** The requirements are in `docs/openspec/`;
run every `openspec` command from `docs/`.

1. **Tenant from the credential, never the body.** `company_id` comes from the user's token, the
   device key, the licence key, an enrollment or invitation token, the Stripe customer or the host
   name, each resolved through a narrow lookup (B3). A request body or query string never selects a company (Plan §6.1).
2. **Every request runs in one transaction with its scope set** (`app.scope`, `app.company_id`)
   before the first query. Row-level security is the backstop, not the control
   ([B2](docs/decisions/backend-decisions.md)).
3. **Staff never read employee data.** No route in `staff` scope touches employees, devices,
   activity, URLs or screenshots, and there is no impersonation (D41).
4. **No secret in a log.** Licence keys, enrollment tokens, device keys, uninstall tokens, JWTs,
   signed URLs and Stripe secrets are never logged at any level. Secrets are stored hashed; the two
   an admin must see again are also encrypted (B6).
5. **The agents' contract is a promise.** The agent repositories specify what they send and how
   they react to every status and `code`. Never change a route, field, status or `code` they rely
   on without a spec change here and in both agent repositories ([agent-contract.md](docs/core/api/agent-contract.md)).
6. **Writes from agents are idempotent.** Activity batches, screenshots and tamper events carry an
   ID; a repeat returns the original result, never a second row (D13).
7. **Seats are counted, never stored**, and the database enforces the limit (D43, B4).
8. **Scheduled work runs only through `/cron/*` routes** called by the scheduler, in `system`
   scope. No in-process timers: they run once per instance (Plan §3).
9. **Schema changes are numbered, forward-only migrations** in `db/migrations/`, each with its
   self-check in `db/tests/`.
10. **Spec before code.** A behaviour change starts as an OpenSpec change in
    `docs/openspec/changes/`. `openspec validate --all --strict` is a merge gate. **WorkBeat Plan
    v3.2 is the source of truth**; D-numbers are its rulings, B-numbers are this repository's.
