# WorkBeat API

NestJS (Fastify) on plain PostgreSQL. Implements the agent contract
([docs/core/api/agent-contract.md](../../docs/core/api/agent-contract.md)): `/health`,
`/v1/license/validate`, `/v1/devices/enroll`, `/v1/devices/:id/deactivate`, `/v1/agents/heartbeat`,
`/v1/agents/policy`, `/v1/agents/activity`, `/v1/agents/screenshots` (+ `/:id/confirm`),
`/v1/agents/tamper`. Screenshots and agent packages are stored on local disk (`STORAGE_DIR`) behind
signed URLs served by the API (`/v1/storage/...`) until a bucket provider is chosen.

Agent integration guides: [macOS](../../docs/integration/mac-agent-api.md) ·
[Windows](../../docs/integration/windows-agent-api.md).

Portal API (company_admin, manager, it_admin) as in [portal-api.md](../../docs/core/api/portal-api.md),
with these differences, since there is no Supabase:

- **Sign-in is the API's own.** `POST /v1/auth/login` `{ email, password }` → `{ token, expires_at, user }`;
  send `Authorization: Bearer <token>` (`wbs_…`, 7 days). `POST /v1/auth/logout` (204),
  `POST /v1/auth/password` `{ current_password, new_password }` (other sessions end).
  `POST /v1/invitations/accept` also returns a session. Passwords: 10–200 characters, scrypt.
  Forgotten password: `POST /v1/auth/password-reset/request` (always 204) and `/confirm`.
- **Staff (`super_admin`) sign in the same way**, email and password only; there is no MFA
  (removed 16 Nov 2026, B23).
- **Email** goes through Resend (`RESEND_API_KEY`); without it, to `STORAGE_DIR/outbox`.
- **Status codes** follow the api-envelope convention where portal-api.md leaves them open:
  actions answer `200` with the record, creates `201`, deletes and `POST /v1/company/setup/steps` `204`.
- **Field names** chosen where unspecified: lookup `company_name`; billing `scheduled_screenshot_tier`
  and `scheduled_at` (always null); uninstall reveal `uninstall_token`; setup `[{ step, done }]`;
  rollout `{ status: {…}, badges: {…}, healthy }`; import `skipped_emails` and, on 422, `lines`;
  reports `apps` / `websites` lists and `hours: [{ hour, tracked_seconds, activity_percent }]`;
  timesheet `{ employee, company, week, days, totals }`; alerts `{ items, next_cursor }` (pass
  `cursor`; `type` is comma-separated); `EXPORT_TOO_LARGE` carries `cap`.
- **Device `offline`** is also derived from a heartbeat older than 15 minutes, until `/cron/offline` exists.
- **Additions requested by WorkBeat Admin** (`presence`, `devices` and `?manager_user_id=` on employees,
  `company.timezone` on `/v1/me`, a defined device `health`, `group_by` on activity/productivity,
  alert `counts` and `?employee_id=`, `created_by_name`, `GET /v1/agent-versions`):
  [admin-requests-response.md](../../docs/integration/admin-requests-response.md).

## First run

```bash
pnpm install
createdb workbeat_dev
psql -d workbeat_dev -c "CREATE ROLE workbeat_api NOLOGIN; CREATE ROLE wb_api LOGIN PASSWORD 'pick-one' IN ROLE workbeat_api;"
cp .env.example .env            # fill DATABASE_URL (wb_api), ADMIN_DATABASE_URL (owner), SECRETS_ENCRYPTION_KEY
pnpm db:migrate
pnpm seed -- --name "Acme" --slug acme --seats 10 --employees "Ada Lovelace,Alan Turing" --admin-email you@acme.com
                                # prints the licence key and the admin password once
pnpm dev                        # http://localhost:3000
LICENSE_KEY=WB-... pnpm smoke   # end-to-end agent flow; enrolls and deactivates one test device
ADMIN_EMAIL=you@acme.com ADMIN_PASSWORD=... pnpm smoke:portal   # portal flow; adds test users and data
```

`pnpm seed -- --slug <existing> --admin-email …` adds another company admin to an existing company;
`--slug <existing> --rotate-key` issues a new licence key; `--staff-email …` creates a `super_admin`.
`pnpm test` runs the unit tests. `smoke:portal` also checks staff sign-in when `STAFF1_EMAIL`/`STAFF1_PASSWORD` of a test staff
member are set.
DB self-checks (`db/tests/*.sql`) expect an empty database: run them on a fresh one.

The API must connect as a non-superuser role: superusers bypass row-level security.

## Expose to agents

```bash
cloudflared tunnel --url http://localhost:3000
```

Point the agents at the printed `https://….trycloudflare.com` and set `PUBLIC_BASE_URL` to it if
signed upload/download URLs must use that host (by default they use the request's host, which
cloudflared forwards). Check it from outside: `BASE_URL=https://….trycloudflare.com LICENSE_KEY=WB-... pnpm smoke`.

## Not built yet

Stripe (signup, tier change, billing portal, webhooks), custom domains and `/v1/hosts/resolve`,
`timesheet.pdf`, staff routes (`/v1/staff/*`), alert emails, `/cron/*` (offline detection, domain
verification, partitions, retention), agent release upload. Partitions exist for last month to two months ahead
(`ensure_month_partitions`); run `SELECT ensure_month_partitions();` as the owner monthly until
`/cron/cleanup` exists.
