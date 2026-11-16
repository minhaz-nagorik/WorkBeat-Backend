# Security and privacy

The backend holds many companies' monitoring data in one database. The worst outcome is one
company, or WorkBeat staff, seeing another company's employees (Plan §8). Everything below exists
to make that hard and visible.

## Tenant isolation, layer by layer

| Layer | Control | Where |
|---|---|---|
| Credential | `company_id` comes from the JWT `app_metadata`, the device key, the licence key or the host name; never a body, query or path | `request-scope`, rule 1 |
| Lookup | Before a tenant is known, only the `SECURITY DEFINER` functions `auth_device`, `auth_license`, `auth_enrollment_token`, `auth_invitation`, `company_by_host` are used, with SHA-256 hashes | B3 |
| Transaction | Each request is one transaction that sets `app.scope` and `app.company_id` first | B2 |
| Repository | Queries cannot run outside the request transaction; manager team filter applied centrally | `request-scope` 3.2, `manager-teams` 2.2 |
| Database | Row-level security on every tenant table; the API connects as `workbeat_api`, which is subject to it; unset scope sees nothing | `0001_init.sql` |
| Relations | Child rows reference `(id, company_id)`, so a row cannot point into another company | data-model.md |
| Tests | Tenant-isolation suite over every read route; staff boundary test in CI | [testing-strategy.md](../engineering/testing-strategy.md) |

Plan §6.1 assumed a bypass-RLS connection with RLS as an optional extra. B2 and B3 go further: no
request path has a bypass-RLS connection at all.

## Secrets and rotation

| Secret | Stored as | Rotation |
|---|---|---|
| Licence key | SHA-256 + AES-256-GCM ciphertext + last 4 (B6) | Staff reissue (`staff-license-reissue`): new key at once, old key `404`, unused enrollment tokens deleted, seats and devices unchanged, new key emailed to company admins |
| Uninstall token | SHA-256 + AES-256-GCM ciphertext (B6); hash in every policy | **Open**: no route rotates it. If leaked, an operator migration or script would set a new hash and ciphertext and bump `policy_version`; not yet specified |
| Enrollment token | SHA-256, single use, 24 h | Expires; `/cron/token-expiry` deletes unused ones |
| Device key | SHA-256 only | Re-enrolling the device replaces it; deactivating clears it |
| Invitation token | SHA-256 only | Expires; resend issues a new one |
| `SECRETS_ENCRYPTION_KEY` | Environment only | **Open**: rows carry no key version. A rotation would need a migration adding one, a re-encrypt job in `system` scope, then removal of the old key. Not yet specified |
| `CRON_SECRET` | Environment + Vault / Cloud Scheduler | Set the new value in the scheduler and the API in one deploy window; a mismatch only causes `401` and skipped runs, never extra work |
| Stripe, Resend, Supabase service role, JWT secret | Environment only | Roll in the provider console, update the secret store, redeploy. Rolling the JWT secret signs every user out |

Neither open item is yet in [open-questions.md](../decisions/open-questions.md).

## Never logged

At any level, including errors (`api-logging`):

- Licence keys, enrollment tokens, device keys, uninstall tokens, invitation tokens, JWTs, cookies
- `Authorization`, `X-*-Key` and `X-Cron-Secret` headers, Stripe secrets and webhook signatures
- Signed URLs and storage paths
- Window titles, URLs, domains, employee names, from any request or response body
- Request and response bodies, ever. Validation errors log field names only

Emails follow the same idea: alert emails carry event type, hostname, employee name, time and
count, never `detail`, a URL or a title (`alert-emails`).

## Staff boundary (D41)

| Staff can | Staff cannot |
|---|---|
| List and edit companies, licences, seat limits, grace days, status | Read employees, devices, activity, URLs, screenshots, tamper events |
| Reissue a licence key | Impersonate a company user; there is no such feature |
| Manage staff accounts and agent releases | Call any company route (answers `403`) |
| See seat counts through `company_seat_counts()` | Create a `super_admin` through any route (only the operator script does) |

Staff routes run in `staff` scope, where RLS returns no tenant rows, and a CI test fails the build
if any staff response contains seeded employee data.

## Retention and deletion

| Data | Kept |
|---|---|
| Activity (four tables) and screenshots | The company's `data_retention_days`, 1–365 (B13); nightly cleanup. Partitions past 365 days dropped |
| `ingest_batches` | 14 days |
| Resolved tamper events | Company retention; unresolved ones are kept |
| `notice_acknowledgements`, directory and settings rows | Never deleted by cleanup (legal evidence, D25) |
| Unused enrollment tokens | Until expiry, then deleted hourly |

Deleting a whole company on request, and what happens to data of an expired company, are not
specified yet; see [Q14](../decisions/open-questions.md) for the expired case.

## Sensitive domains

The agents drop anything on a sensitive domain before it leaves the device (D4). The backend
stores records as sent and never re-derives, re-filters or adds a URL or title (`activity-ingestion`).
Its part is serving the list: defaults seeded at signup, edited by company admins, delivered in
policy, with every change raising `policy_version`.

## Screenshots

| Control | Detail |
|---|---|
| Storage | Private bucket `screenshots`, `image/jpeg` only, every object under `{company_id}/{device_id}/` |
| Upload | Signed upload URL per screenshot, confirmed by size before it is listed |
| Viewing | Signed view URLs valid 5 minutes, issued per request, never logged |
| Who | `company_admin`, and a `manager` for their own team. `it_admin` and staff get `403` |
| Tier `off` | No URLs issued at all |
| Deletion | Object first, then row, at retention |

## Incident checklist: suspected cross-tenant leak

1. **Contain.** If a route is involved, disable it (deploy with the route refused) or roll back
   the revision. Do not wait for proof.
2. **Preserve.** Export the API logs for the window (they carry request ID, route, scope, company
   and device IDs, no content) and take a database snapshot.
3. **Scope.** From logs, list requests on the route whose resolved `company_id` differs from the
   company of the returned rows. Check for a missing `SET LOCAL`, a query outside the request
   transaction, or a new `SECURITY DEFINER` function.
4. **Verify the backstop.** Run the self-checks and the tenant-isolation suite against the
   deployed revision.
5. **Fix forward** with a test that reproduces the leak first; ship the fix and the test together.
6. **Rotate** anything the leak could expose (licence keys by reissue, uninstall token, service keys).
7. **Notify.** Affected companies are data controllers for their employees' data; tell them what
   was exposed and when. Who sends it and the deadlines per market are for counsel and product.
8. **Write it up**: timeline, cause, the missing layer, and the test that now guards it.

## Reporting a vulnerability

Report it privately to the backend owner. Do not open a public issue.
