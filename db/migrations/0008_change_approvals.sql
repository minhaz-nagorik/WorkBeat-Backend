-- WorkBeat backend — IT Admin writes wait for a Company Admin's approval (admin round 6,
-- product owner 17 Nov 2026). A change keeps the request it will replay and who asked.
-- Self-check: db/tests/0008_change_approvals_test.sql.

BEGIN;

CREATE TABLE changes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'failed')),
  resource     text NOT NULL CHECK (resource IN ('employee', 'employee_import', 'monitoring_settings', 'pause', 'device', 'alert',
                                                 'block_rule', 'sensitive_domain', 'productivity_rule')),
  action       text NOT NULL CHECK (action IN ('create', 'update', 'delete', 'release', 'deactivate', 'resolve', 'cancel', 'import')),
  target_id    uuid,
  summary      text NOT NULL CHECK (length(summary) BETWEEN 1 AND 300),
  method       text NOT NULL CHECK (method IN ('POST', 'PUT', 'PATCH', 'DELETE')),
  path         text NOT NULL,                 -- the request as sent, replayed on approval
  content_type text,
  body         text,
  requested_by uuid NOT NULL REFERENCES users,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by   uuid REFERENCES users,
  decided_at   timestamptz,
  reason       text CHECK (length(reason) <= 500),
  error        jsonb,
  notified_at  timestamptz,                   -- this change triggered the "waiting" email to admins
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status = 'failed') = (error IS NOT NULL))
);
CREATE INDEX changes_company ON changes (company_id, requested_at DESC);

ALTER TABLE changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON changes USING (company_id = app_company_id() OR app_scope() = 'system')
  WITH CHECK (company_id = app_company_id() OR app_scope() = 'system');
GRANT SELECT, INSERT, UPDATE ON changes TO workbeat_api;

COMMIT;
