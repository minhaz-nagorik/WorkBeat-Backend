# Deployment

How the API and its Supabase project are stood up and released. The web platform (Vercel) and the
agents have their own repositories and guides.

## What runs where

| Piece | Where | Notes |
|---|---|---|
| API (`apps/api`) | Container, **Google Cloud Run** by default | Plan §2.1 allows Cloud Run, Fly or Render |
| Database | Supabase PostgreSQL 15+ | Reached through the Supavisor pooler in transaction mode |
| Auth | Supabase Auth, same project | Company users and staff together (D41) |
| Files | Supabase Storage, same project | Private buckets `screenshots` and `agents` |
| Scheduler | Supabase pg_cron + pg_net, or Cloud Scheduler | Calls `/cron/*` ([scheduled-jobs.md](scheduled-jobs.md)) |
| Email | Resend | Sending domain verified per environment |
| Billing | Stripe | Webhook to the API |

### Why Cloud Run by default, and what is open

| For Cloud Run | Still open |
|---|---|
| Stateless containers scale on request rate, which is what the agent cadence produces | The final host is not recorded as a decision; not yet in [open-questions.md](../decisions/open-questions.md) |
| Cloud Scheduler sits beside it if pg_cron is not used | The region, and where EU customers live ([Q11](../decisions/open-questions.md)) |
| Q15 already assumes Cloud Run | Which proxy terminates TLS for custom domains ([Q15](../decisions/open-questions.md)) |

Nothing in the API depends on Cloud Run: it listens on `PORT`, keeps no local state and runs no
timers, so Fly or Render need only a different deploy step.

## Supabase project setup

One project per environment. Each holds both company users and staff.

| Area | Setting |
|---|---|
| Auth | Email + password. Role and `company_id` live in `app_metadata`, written only by the API with the service role key (D41). `user_metadata` is ignored by the guard |
| Auth: first staff account | Created by the operator script from `authenticate-users` task 4.3; there is no route for it |
| Storage | Buckets `screenshots` (private, `image/jpeg` only, size limit from `packages/shared`) and `agents` (private). No public bucket |
| Database: pooler | Supavisor **transaction mode** (port 6543) for the API. Session mode and the direct connection are for migrations only |
| Database: extensions | `citext`, `btree_gist` (created by the migrations); `pg_cron`, `pg_net` and Vault if pg_cron is the scheduler |
| Database: roles | The migrations create `workbeat_api` as `NOLOGIN`. Ops create a login user and grant it the role (below) |
| API access | Supabase's `anon` and `authenticated` roles get no table access; disable the Data API for `public` or leave it with no grants |

### The API's login user

```sql
-- run once per project, as postgres, after 0001 is applied
CREATE ROLE wb_api LOGIN PASSWORD '<generated>' NOINHERIT;
GRANT workbeat_api TO wb_api;
ALTER ROLE wb_api SET role = 'workbeat_api';   -- every session acts as workbeat_api, under RLS
```

The API never connects as `postgres`, `service_role` or any role with `BYPASSRLS` (B2, B3). Put
the password only in `DATABASE_URL` in the secret store.

## Releasing

1. A tag `vX.Y.Z` on `main` builds the container and runs the full test suite.
2. **Migrations** are applied to the environment (next section).
3. The new revision is deployed with no traffic, `GET /health` is checked, then traffic moves.
4. Smoke checks: `GET /health` 200, one heartbeat from a staging test device, one `/cron/token-expiry`
   call returning `200`.

Staging gets every merge to `main`; production gets tags, after an approval.

## Migration rollout order

| Step | Why |
|---|---|
| 1. Apply new migrations (runner, `schema-migrations` task 6.1) through the session-mode or direct connection | Transaction-mode pooling and long DDL do not mix |
| 2. Self-checks run against a staging copy first | A failing check on staging blocks production |
| 3. Deploy the API that uses the new schema | Old revisions still run during the switch |
| 4. A later release removes anything the old code needed | Migrations are forward-only; nothing is undone in place |

Every migration has to work with the API version before it and after it.

## Stripe webhook endpoint

| Setting | Value |
|---|---|
| URL | `https://<api host>/v1/webhooks/stripe` |
| Events | `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.paid` |
| Secret | The endpoint's `whsec_…` into `STRIPE_WEBHOOK_SECRET` |
| Prices | Created per mode; their IDs go into the `STRIPE_PRICE_*` variables. Starter/Growth minimum charges are open ([Q12](../decisions/open-questions.md)) |

Stripe retries failed deliveries; the API stores each event by `id` and runs it once.

## Resend domain

Verify a sending subdomain (for example `mail.workbeat.io`) with Resend's SPF and DKIM records and
add a DMARC record. Staging uses its own subdomain so test email never shares a reputation with
production. Set `EMAIL_FROM` to an address on it.

## Custom domains

The API verifies ownership (TXT `_workbeat.{domain}` = `verify-{token}`) and shows the CNAME target
`proxy.workbeat.io` (`custom-domains`). What answers at `proxy.workbeat.io` and terminates TLS for
customer domains is open ([Q15](../decisions/open-questions.md)). Until it is answered, custom
domains can be verified but not served.

## Rollback

| What went wrong | Do |
|---|---|
| New API revision misbehaves | Move traffic back to the previous revision. It still works because migrations are backward compatible |
| A migration is wrong | Write and ship a new migration that corrects it. Never edit or reverse the applied file |
| Data damaged by a bug | Supabase point-in-time recovery into a **new** project, then copy back the affected rows; never restore over production |
| A secret leaked | [security-and-privacy.md](security-and-privacy.md#secrets-and-rotation) |
