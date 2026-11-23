# Notice to WorkBeat Admin — round 8: employee CSV import

**From:** WorkBeat-Backend · **To:** WorkBeat Admin · **Date:** 23 November 2026
**Follows:** round 7, answered. **Not a reply:** the product owner asked for this change on 23 Nov 2026.

Built and documented in `portal-api.md` (`POST /v1/employees/import/check` and
`POST /v1/employees/import`) and in `employee-directory` (manage-employees, edited in place). The
console side is already built: the Import employees page at `/employees/import` replaces the dialog.
Not yet run against a database: `pnpm smoke:portal` covers it.

## What the product owner asked for

- Company Admins and IT Admins import employees from a CSV made from a downloadable template.
- After the file is sent, every row is shown: green when valid, red with its problem. The admin
  edits the red rows, or cancels and fixes the file.
- An email that a current employee already has is an error, not a skip.
- At most 500 employees per import.
- Imported employees get computers through the normal WorkBeat Setup flow.

## New: `POST /v1/employees/import/check`

- Same body as the import: the raw file, `Content-Type: text/csv`, at most 2 MiB.
- Answers `200 { rows, invalid, archived }`. `invalid` is `[{ line, reasons }]` with the reasons the
  import would give.
- Writes nothing and never waits for approval, so an IT Admin sees the red rows straight away.
- Needs `employees.edit`; without it the answer is `403`.

## Changed: `POST /v1/employees/import`

| | before | now |
|---|---|---|
| Existing employee's email | row skipped | row invalid, reason `email_exists` |
| `201` body | `created`, `skipped`, `skipped_emails` | `created` only |
| `422` body | `lines`, and `archived` when relevant | `lines`, `invalid: [{ line, reasons }]`, and `archived` when relevant |
| Row limit | 5,000 | 500; 501 rows answer `413 PAYLOAD_TOO_LARGE` |
| File with no data rows | `201` with `created: 0` | `422 VALIDATION_FAILED` |
| UTF-8 BOM (files saved by Excel) | read as part of the header, so line 1 failed | stripped |

It is still all or nothing. Line numbers still count data rows, not the header. An IT Admin's import
still answers `202 { change }` once the whole file is valid, and approving it replays the stored file.

## Reasons

| reason | meaning |
|---|---|
| `name_required` | no name |
| `email_invalid` | email missing or malformed |
| `email_repeated` | the same email on more than one line (case ignored) |
| `email_exists` | a current employee has the email |
| `email_archived` | only a removed employee has the email; restore them instead (see `archived`) |
| `manager_unknown` | `manager email` is not an enabled user of a team-only role |

A row can have more than one reason. A new reason may be added later, so show any unknown reason as
a generic problem.

## Race

If another write takes one of the emails between the check and the import, the import answers
`409 CONFLICT` and writes nothing. Check again to see the row red.
