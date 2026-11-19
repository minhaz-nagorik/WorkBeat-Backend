## Why

Every device belongs to an employee from the moment it enrolls (D47), and every device's policy is
resolved from that employee's switches and pauses (D37, D31). The company therefore needs its
people in WorkBeat before the first install: a directory with CSV import (PRD "Permission
matrix"), one manager per employee for scoped reports (B12, Plan-v3.5 §4.4 "Manager
scoping"), per-employee monitoring switches within the screenshot tier (B11), and monitoring
pauses for leave (D31–D34). Removing an employee must not orphan a device (D47).

## What Changes

- **Employee directory**: add, edit, list, CSV import and remove (archive) employees; removal is
  refused with `409 EMPLOYEE_HAS_DEVICES` while any binding of the employee is not released,
  deactivated ones included (D44, D46, D48). A returning employee is restored, not created
  again: `POST /v1/employees/:id/restore`, and an import row holding only an archived employee's
  email is refused (D46).
- **Manager teams**: one manager per employee (B12); a manager reads only their own team and
  writes nothing.
- **Monitoring settings**: the four switches and the screenshot interval per employee, created
  with the employee, validated against the company's tier (D37, B11).
- **Monitoring pauses**: schedule, extend and cancel a pause for one employee; overlaps refused
  (D31). Every change bumps the employee's `policy_version`.
- New portal codes: `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409),
  `EMPLOYEE_HAS_DEVICES` (409).

## Capabilities

### New Capabilities

- `employee-directory`: employee CRUD, CSV import, archive and who may read the directory.
- `manager-teams`: the one-manager rule and the manager's read-only team scope.
- `monitoring-settings`: per-employee feature switches and screenshot interval.
- `monitoring-pauses`: pause windows per employee and their effect on `policy_version`.

### Modified Capabilities

None.

## Impact

- Routes: `GET/POST /v1/employees`, `GET/PATCH/DELETE /v1/employees/:id`,
  `POST /v1/employees/:id/restore`,  `POST /v1/employees/import`, `GET/PUT /v1/employees/:id/monitoring-settings`,
  `GET/POST /v1/employees/:id/pauses`, `PATCH /v1/employees/:id/pauses/:pause_id`,
  `POST /v1/employees/:id/pauses/:pause_id/cancel`.
- Consumed by `enroll-devices` (the employee list and `EMPLOYEE_NOT_FOUND`), `serve-agent-policy`
  (switches and pauses in policy) and `receive-device-health` (`monitoring_pause` on the heartbeat).
- Agent specs relying on it: Mac `report-device-health` `monitoring-features` and
  `monitoring-pause`; the Downloader's employee list (`bootstrap-manual-install` `downloader`).
- Roles come from `authenticate-users` `role-access`. Schema: `employees`,
  `employee_monitoring_settings`, `monitoring_pauses` and their triggers in `0001_init.sql`.
