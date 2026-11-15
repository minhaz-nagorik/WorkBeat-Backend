## Why

A device joins a company only with the licence key (D43): the Downloader exchanges it at
`/license/validate` for a single-use enrollment token bound to the employee IT picked (B8, D26,
D42, D44), and the agent exchanges that token at `POST /v1/devices/enroll` for its device key (D3).
The seat is filled at enrollment, never at validation (Plan-v3.2 §5.3, B4), and the same hardware
reuses its row and seat (D2). Every later agent call is authenticated by that key and answered
with the 401/402 codes the agents branch on (D5, D6, D29, D30, D36, D38). Deactivate, release and
reassign close the lifecycle (Plan-v3.2 §5.8, D38, D44).

## What Changes

- **Licence validation** in two steps (B8): company and employee list, then a 24-hour single-use
  token bound to the chosen employee. Nothing is reserved.
- **Device enrollment**: token checked, seat taken by the database (`devices_seat`), row reused for
  known hardware (D2), device key returned once and stored only as SHA-256.
- **Device authentication** for `/agents/*` and `POST /v1/devices/:id/deactivate`: `401
  DEVICE_REVOKED` / `DEVICE_RELEASED`, `402 COMPANY_SUSPENDED` / `LICENSE_EXPIRED` with
  `blocking_ends_at`, then tenant scope.
- **Device lifecycle**: deactivate (portal or uninstaller), release, reassign to another active
  employee only.
- Amends the agent repositories where D43/D44 are newer; see [design.md](design.md).

## Capabilities

### New Capabilities

- `license-validation`: `POST /v1/license/validate`, both steps and every refusal.
- `device-enrollment`: `POST /v1/devices/enroll`, new rows, reuse, seat and token use.
- `device-authentication`: the device-key guard and the company-state answers on agent routes.
- `device-lifecycle`: deactivate, release and reassign.

### Modified Capabilities

None.

## Impact

- Routes: `POST /v1/license/validate`, `POST /v1/devices/enroll`, `POST /v1/devices/:id/deactivate`
  (device key or portal user), `POST /v1/devices/:id/release`, `POST /v1/devices/:id/reassign`.
- Consumed by the Downloader (Mac `bootstrap-manual-install` `downloader`) and both agents (Mac
  `enroll-device` `device-enrollment`, `device-credentials`, `device-release`;
  `report-device-health` `suspended-company`; `status-code-handling.md`).
- Depends on `manage-employees` (active employees) and `provision-companies` (`license-key`,
  `company-status`). The portal device list and status are `receive-device-health`
  `device-status`; a key reissue deleting unused tokens is `administer-platform`
  `staff-license-reissue`.
- Schema: `enrollment_tokens`, `devices`, `devices_seat`, `devices_policy`, `auth_license`,
  `auth_enrollment_token`, `auth_device` in `0001_init.sql`.
