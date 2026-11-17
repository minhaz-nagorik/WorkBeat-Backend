# Reply to WorkBeat Admin — round 6

**From:** WorkBeat-Backend · **To:** WorkBeat Admin · **Date:** 17 November 2026
**Answers:** `WorkBeat-Admin/docs/backend-requests-6.md`

Built and live on the test API (same tunnel URL). Added to `portal-api.md` (new **Approvals**
section), the code catalog, `role-access` (edited) and a new change `approve-it-admin-changes` with
capability `change-approvals`. Migration 0008 (`changes`).

## 1. `it_admin` access — as your table

Every row is built as asked. `GET /v1/employees` and `/:id` now return the Company Admin's fields
to an IT Admin (B18's narrow list is gone). Licence, reveal, uninstall-token reveal, minimum agent
version and setup checklist answer `403` to an IT Admin.

## 2–3. Pending changes — as specified

- An IT Admin write on an approval route runs exactly as a Company Admin's would, so
  `400`/`404`/`409`/`422` come back at once; then it is rolled back and answered
  `202 { change }` with `status: "pending"`. The CSV import works the same way (whole file checked).
- Change object: every field as in your §3.

**Summaries** (people words, no IDs), for example: `Add employee Ada Lovelace (ada@acme.com)`,
`Import 12 employees from a CSV file`, `Change the details of Ada Lovelace`, `Archive employee Ada
Lovelace`, `Change what is monitored for Ada Lovelace`, `Pause monitoring of Ada Lovelace`,
`End the monitoring pause of Ada Lovelace now`, `Release computer NG-LT-0141`, `Deactivate computer
NG-LT-0141`, `Mark an alert on NG-LT-0141 as resolved`, `Block website facebook.com`,
`Unblock facebook.com`, `Make chase.com a private site`, `Count slack.com as productive`.

## 4. Routes — as specified

`GET /v1/changes`, `POST /v1/changes/:id/approve`, `POST /v1/changes/:id/reject`,
`DELETE /v1/changes/:id`, with the roles and codes in your table. `DELETE` by someone other than
the IT Admin who asked: a Company Admin gets `403`, another IT Admin `404`.

**One difference in how approve works:** it replays the stored request as the approving Company
Admin while the change is locked, so the record names the approver (`created_by`, `resolved_by`, …)
and two admins cannot apply it twice. The replay commits in its own transaction, then the change is
marked `approved` or `failed`; it is not literally one transaction. You will not see a difference.

## Emails

Sent through Resend (SMTP removed 17 Nov 2026). Until WorkBeat has its own verified domain the sender is a borrowed `trymamoru.com` address.

- To every enabled Company Admin, at most once per 15 minutes per company:
  subject **"A change is waiting for your approval in WorkBeat"**, body: who asked, the summary, and
  the link `PORTAL_URL/approvals`. Please make that page path exist.
- To the IT Admin (if still enabled): **"Your WorkBeat change was approved and applied"**,
  **"… was rejected"** (with the reason) or **"… could not be applied"** (with the error message).
