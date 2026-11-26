## Why

A device joins a company only with the licence key (D43): the Downloader exchanges it at
`/license/validate` for a single-use enrollment token bound to the employee IT picked (B8, D26,
D42, D47), and the agent exchanges that token at `POST /v1/devices/enroll` for its device key (D3).
The seat is filled at enrollment, never at validation (Plan-v3.5 §5.3, B4). An enrollment makes a
binding of the device ID, the company's licence and one employee that never changes employee (D48,
Plan-v3.5 §4.4 "Device binding"); the same device ID for the same employee keeps its binding and
seat (D2). Every later agent call is authenticated by that key and answered with the 401/402 codes
the agents branch on (D5, D6, D29, D30, D36, D38). Only a release ends a binding (there is no deactivate, B35); a released
key still uploads for 7 days (Plan-v3.5 §5.8, D38, D45).

## What Changes

- **Licence validation** in two steps (B8): company and employee list, then a 24-hour single-use
  token bound to the chosen employee. Nothing is reserved.
- **Device enrollment**: token checked, seat taken by the database (`devices_seat`). No live
  binding for the device ID → new binding; live binding of the token's employee → same binding with
  a new key (D2); live binding of another employee → `409 DEVICE_ASSIGNED`, nothing written (D48).
  Response carries `outcome` and `notice_required`; a re-enrollment while the old key heartbeated in
  the last 15 minutes raises a `duplicate_device_id` alert (D46). Device key returned once and stored
  only as SHA-256.
- **Device authentication** for `/agents/*`: `401
  DEVICE_REVOKED` / `DEVICE_RELEASED` (with `released_at`, `upload_until`; the released key still
  accepted on the upload routes for 7 days, D45), `402 COMPANY_SUSPENDED` / `LICENSE_EXPIRED` with
  `blocking_ends_at`, then tenant scope.
- **Device lifecycle**: release only; the uninstaller calls `POST /v1/agents/uninstall`, which frees the seat and marks the device `uninstalled` (B36; amends B35). A binding's employee never
  changes; no route moves a device to another employee (D48).
- Amends the agent repositories where D43/D47 are newer; see [design.md](design.md).

## Capabilities

### New Capabilities

- `license-validation`: `POST /v1/license/validate`, both steps and every refusal.
- `device-enrollment`: `POST /v1/devices/enroll`, new binding, same binding, `409 DEVICE_ASSIGNED`, seat and token use.
- `device-authentication`: the device-key guard and the company-state answers on agent routes.
- `device-lifecycle`: release, uninstall, no deactivate, and the fixed employee of a binding.

### Modified Capabilities

None.

## Impact

- Routes: `POST /v1/license/validate`, `POST /v1/devices/enroll`,
  `POST /v1/devices/:id/release`. There is no route that moves a device
  to another employee.
- New error code `409 DEVICE_ASSIGNED`; new backend-only tamper `event_type` `duplicate_device_id`.
- Consumed by the Downloader (Mac `bootstrap-manual-install` `downloader`) and both agents (Mac
  `enroll-device` `device-enrollment`, `device-credentials`, `device-release`;
  `report-device-health` `suspended-company`; `status-code-handling.md`).
- Depends on `manage-employees` (active employees) and `provision-companies` (`license-key`,
  `company-status`). The portal device list and status are `receive-device-health`
  `device-status`; a key reissue deleting unused tokens is `administer-platform`
  `staff-license-reissue`.
- Schema: `enrollment_tokens`, `devices`, `devices_seat`, `auth_license`, `auth_enrollment_token`
  in `0001_init.sql`; `0003_device_binding.sql` drops `devices_policy`, adds `devices_employee_fixed`,
  returns `released_at` from `auth_device` and adds `duplicate_device_id`.
