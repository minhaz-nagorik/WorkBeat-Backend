## Why

The product owner decided on 17 Nov 2026 that an IT Admin may prepare the same changes as a Company
Admin on employees, devices, alerts and the policy lists, but none takes effect until a Company Admin
approves it. The IT Admin loses the Deployment area and still sees no activity data.

## What Changes

- An `it_admin` write on an approval route is validated as today, then stored as a pending change
  and answered `202 { change }`; nothing is applied.
- `GET /v1/changes`, `POST /v1/changes/:id/approve`, `POST /v1/changes/:id/reject`,
  `DELETE /v1/changes/:id`; emails to Company Admins and to the requester.
- `it_admin` reads the Company Admin's employee fields, monitoring settings, pauses, private sites
  and productivity rules; loses licence, uninstall token, minimum version and setup checklist.
- Migration 0008 adds `changes`.

## Capabilities

### New Capabilities

- `change-approvals`: pending changes, approval, rejection, cancellation and their emails.

### Modified Capabilities

- `role-access` (authenticate-users): the IT Admin's access, edited in place there.

## Impact

- Consumed by the web platform (Approvals page, IT Admin pages).
