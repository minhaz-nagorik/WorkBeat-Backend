# Environments and configuration

## Environments

| | API | Dashboard host | Database | Stripe | Built by |
|---|---|---|---|---|---|
| **Local** | `http://localhost:3000` | `localhost` (no tenant host) | Local Postgres or `supabase start` | Test mode, `stripe listen` forwarding | Developer |
| **Staging** | `https://api.staging.workbeat.io` | `{slug}.staging.workbeat.io` | Staging Supabase project | Test mode | CI, from `main` |
| **Production** | `https://api.workbeat.io` | `{slug}.workbeat.io` | Production Supabase project | Live mode | CI, tagged release |

Host names other than `workbeat.io` and `{slug}.workbeat.io` (which the specs use) are placeholders.
Which API hosts a release build of the agents accepts is open
([Q6](../decisions/open-questions.md)). Each environment has its own Supabase project, its own
secrets and its own Stripe mode; nothing is shared between them.

## Environment variables

The API validates all of these at start and refuses to boot when one is missing or malformed
(`establish-api-foundation` task 1.2). Names are the proposed ones; change 1 fixes them in
`apps/api/.env.example`.

| Name | Used by | Secret? | Example |
|---|---|---|---|
| `DATABASE_URL` | Every request; Supavisor pooler, **transaction mode**, as the API login user (a member of `workbeat_api`) | yes | `postgres://wb_api.<ref>:…@aws-0-eu-central-1.pooler.supabase.com:6543/postgres` |
| `SUPABASE_URL` | Auth admin calls (invitations, signup, session revocation), Storage | no | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | Not used by the API; listed so nobody adds it. The web platform holds its own | no (public) | `eyJ…` |
| `SUPABASE_SERVICE_ROLE_KEY` | Auth admin API (writing `app_metadata`), Storage signed URLs and deletes. **Never** used for database queries | yes | `eyJ…` |
| `SUPABASE_JWT_SECRET` | Bearer guard: verifies signature, issuer and expiry of user tokens | yes | 40+ random characters |
| `SUPABASE_JWT_ISSUER` | Bearer guard issuer check | no | `https://<ref>.supabase.co/auth/v1` |
| `SECRETS_ENCRYPTION_KEY` | AES-256-GCM of `licenses.key_ciphertext` and `companies.uninstall_token_ciphertext` (B6) | yes | 32 bytes, base64 |
| `CRON_SECRET` | Cron guard, compared to `X-Cron-Secret` in constant time (B10) | yes | 32+ random bytes, base64url |
| `STRIPE_SECRET_KEY` | Billing reads, tier change, portal session, subscription re-read | yes | `sk_live_…` / `sk_test_…` |
| `STRIPE_WEBHOOK_SECRET` | `POST /v1/webhooks/stripe` signature check | yes | `whsec_…` |
| `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_ENTERPRISE` | Price → plan map | no | `price_1Q…` |
| `STRIPE_PRICE_TIER_LIGHT`, `_STANDARD`, `_INTENSIVE` | Price → screenshot tier map | no | `price_1Q…` |
| `RESEND_API_KEY` | Welcome, invitation, key reissue and alert emails | yes | `re_…` |
| `EMAIL_FROM` | Sender of every email | no | `WorkBeat <no-reply@mail.workbeat.io>` |
| `STORAGE_BUCKET_SCREENSHOTS` | Screenshot upload, view and retention sweep | no | `screenshots` |
| `STORAGE_BUCKET_AGENTS` | Agent and Downloader releases, installer downloads, `update_package_url` | no | `agents` |
| `PUBLIC_BASE_DOMAIN` | Dashboard URL in emails (`https://{slug}.{domain}`), host resolution, the `workbeat.io` refusal for custom domains | no | `workbeat.io` |
| `CUSTOM_DOMAIN_CNAME_TARGET` | Shown to admins for a custom domain | no | `proxy.workbeat.io` |
| `PORT`, `LOG_LEVEL` | Server | no | `3000`, `info` |

**Stripe price IDs.** `provision-companies` task 1.2 puts the price → plan and price → tier maps
in `packages/shared`, but price IDs differ between Stripe test and live mode. The proposal above
keeps the IDs in the environment and the map's *shape* in `packages/shared`; settle it in change 3.

**Bucket names** follow the specs: `screenshots` and `agents`. Plan §2.1 calls the second one
"installers"; it is the same bucket.

## What lives in `packages/shared` instead

Constants that are part of the contract or the behaviour, not of an environment. The specs place
each of these in `packages/shared`, so they change only through a spec change and a release:

| Constant | Spec |
|---|---|
| Error `code` catalog, per-route body limits, all zod schemas | `api-envelope` |
| Rate limits per device key, licence key, user and IP | `rate-limiting` |
| Screenshot view URL lifetime (5 min), upload URL lifetime, max JPEG size | `screenshot-access`, `screenshot-upload` |
| Installer download URL lifetime | `installer-downloads` |
| Offline threshold (15 min) | `offline-detection` |
| Custom-domain verification cut-off | `custom-domains` |
| Invitation lifetime | `team-invitations` |
| Cleanup batch size and time budget | `data-retention` |
| Plan seat limits, trial length, tier add-on prices (MRR estimate) | `company-signup`, `staff-companies` |
| Default notice text, default sensitive domains and productivity rules | `company-signup` |
| CSV import row limit, export row cap, report page sizes, browser app list | `employee-directory`, `data-export`, `usage-reports` |
| Agent cadences (heartbeat 5 min, policy 30 min, batch 10 min) used to size limits | agent repositories, via `packages/shared` |

`packages/shared` is consumed by the web platform and, as exported schemas, by both agents.
**A secret never goes into it**, not even a test key: anything there ships to other
repositories and to browsers.

## Deliberately not configurable

- **The scope model** (`tenant`, `staff`, `system`). There is no flag that lets a route skip it.
- **The retention choices** 30, 60 or 90 days (B13). Companies pick one; operators cannot add others.
- **The B7 window** (now − 8 days to now + 1 day).
- **Logging of bodies or secrets.** There is no debug level that turns it on.

## Local `.env`

Use test values only: a Stripe test key, `stripe listen --forward-to localhost:3000/v1/webhooks/stripe`
for the webhook secret, the local Supabase keys printed by `supabase start`, and freshly generated
encryption and cron secrets (`openssl rand -base64 32`). Never copy a staging or production value
to a laptop.
