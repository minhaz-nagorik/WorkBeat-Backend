-- WorkBeat backend — custom roles and maker-checker for every company user (product owner 19 Nov 2026).
-- Company Admin is the only fixed company role. Company Admins make the other roles: a name, the
-- areas it may see or change, and "own team only". Existing IT Admins and Managers move to a role
-- of that name in their company, with the access they had. Changes now cover team, settings,
-- deployment and roles too, so their kinds are widened.
-- Self-check: db/tests/0013_custom_roles_test.sql.

BEGIN;

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  permissions text[] NOT NULL DEFAULT '{}' CHECK (permissions <@ ARRAY['reports', 'employees.view', 'employees.edit',
                'devices.view', 'devices.edit', 'alerts.view', 'alerts.edit', 'policy.view', 'policy.edit', 'deployment']),
  team_only   bool NOT NULL DEFAULT false,  -- sees and is assigned only the employees they manage
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, company_id)
);
CREATE UNIQUE INDEX roles_name ON roles (company_id, lower(name));
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON roles USING (company_id = app_company_id() OR app_scope() = 'system')
  WITH CHECK (company_id = app_company_id() OR app_scope() = 'system');
GRANT SELECT, INSERT, UPDATE, DELETE ON roles TO workbeat_api;

ALTER TABLE users ADD COLUMN role_id uuid REFERENCES roles;
ALTER TABLE invitations ADD COLUMN role_id uuid REFERENCES roles ON DELETE CASCADE;
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE invitations DROP CONSTRAINT invitations_role_check;

-- Each company with IT Admins or Managers (users or open invitations) gets those roles.
INSERT INTO roles (company_id, name, permissions, team_only)
SELECT DISTINCT x.company_id, r.name, r.permissions, r.team_only
  FROM (SELECT company_id, role FROM users WHERE role IN ('it_admin', 'manager')
        UNION SELECT company_id, role FROM invitations WHERE role IN ('it_admin', 'manager')) x
  JOIN (VALUES
    ('it_admin', 'IT Admin', ARRAY['employees.view', 'employees.edit', 'devices.view', 'devices.edit', 'alerts.view', 'alerts.edit',
                                   'policy.view', 'policy.edit', 'deployment'], false),
    ('manager', 'Manager', ARRAY['reports', 'employees.view', 'alerts.view', 'policy.view'], true)
  ) r(old, name, permissions, team_only) ON r.old = x.role;

UPDATE users u SET role = 'member', role_id = r.id FROM roles r
 WHERE r.company_id = u.company_id AND r.name = CASE u.role WHEN 'it_admin' THEN 'IT Admin' ELSE 'Manager' END
   AND u.role IN ('it_admin', 'manager');
UPDATE invitations i SET role = 'member', role_id = r.id FROM roles r
 WHERE r.company_id = i.company_id AND r.name = CASE i.role WHEN 'it_admin' THEN 'IT Admin' ELSE 'Manager' END
   AND i.role IN ('it_admin', 'manager');

ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin', 'company_admin', 'member'));
-- A removed member may lose their role when it is deleted; an enabled one always has one.
ALTER TABLE users ADD CONSTRAINT users_role_id CHECK ((role = 'member' OR role_id IS NULL) AND (role <> 'member' OR role_id IS NOT NULL OR disabled_at IS NOT NULL));
ALTER TABLE users ADD CONSTRAINT users_role_company FOREIGN KEY (role_id, company_id) REFERENCES roles (id, company_id);
ALTER TABLE invitations ADD CONSTRAINT invitations_role_check CHECK (role IN ('super_admin', 'company_admin', 'member'));
ALTER TABLE invitations ADD CONSTRAINT invitations_role_id CHECK ((role = 'member') = (role_id IS NOT NULL));
ALTER TABLE invitations ADD CONSTRAINT invitations_role_company FOREIGN KEY (role_id, company_id) REFERENCES roles (id, company_id) ON DELETE CASCADE;

-- Alert email recipients: 'company_admin' or a role id.
UPDATE companies c SET alert_email = jsonb_set(alert_email, '{roles}', coalesce((
  SELECT jsonb_agg(DISTINCT v) FROM (
    SELECT CASE x WHEN 'company_admin' THEN 'company_admin'
                  ELSE (SELECT r.id::text FROM roles r WHERE r.company_id = c.id
                         AND r.name = CASE x WHEN 'it_admin' THEN 'IT Admin' ELSE 'Manager' END) END AS v
      FROM jsonb_array_elements_text(c.alert_email -> 'roles') x) y WHERE v IS NOT NULL), '["company_admin"]'));
UPDATE companies SET alert_email = jsonb_set(alert_email, '{roles}', '["company_admin"]') WHERE alert_email -> 'roles' = '[]';
ALTER TABLE companies ALTER COLUMN alert_email SET DEFAULT
  '{"roles": ["company_admin"], "types": ["process_restart", "hosts_modified", "config_changed", "clock_tampered", "permission_revoked", "offline", "duplicate_device_id"], "delivery": "instant"}';

-- Changes cover every company write now.
ALTER TABLE changes DROP CONSTRAINT changes_resource_check;
ALTER TABLE changes DROP CONSTRAINT changes_action_check;
ALTER TABLE changes ADD CONSTRAINT changes_resource_check CHECK (resource IN ('employee', 'employee_import', 'monitoring_settings', 'pause',
  'device', 'alert', 'block_rule', 'sensitive_domain', 'productivity_rule', 'invitation', 'user', 'role', 'company_settings', 'deployment'));
ALTER TABLE changes ADD CONSTRAINT changes_action_check CHECK (action IN ('create', 'update', 'delete', 'release', 'deactivate', 'resolve',
  'cancel', 'import', 'restore', 'resend'));

DROP FUNCTION auth_session(text);
CREATE FUNCTION auth_session(p_token_hash text)
RETURNS TABLE (session_id uuid, user_id uuid, company_id uuid, role text, email citext, name text, must_change_password bool,
               role_id uuid, role_name text, permissions text[], team_only bool)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, u.id, u.company_id, u.role, u.email, u.name, u.must_change_password,
         r.id, r.name, coalesce(r.permissions, '{}'), coalesce(r.team_only, false)
    FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN roles r ON r.id = u.role_id
   WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL
$$;

DROP FUNCTION auth_invitation(text);
CREATE FUNCTION auth_invitation(p_token_hash text)
RETURNS TABLE (invitation_id uuid, company_id uuid, email citext, role text, usable bool, role_id uuid, role_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.id, i.company_id, i.email, i.role, i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now(), r.id, r.name
    FROM invitations i LEFT JOIN roles r ON r.id = i.role_id WHERE i.token_hash = p_token_hash
$$;

REVOKE ALL ON FUNCTION auth_session(text), auth_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_session(text), auth_invitation(text) TO workbeat_api;

COMMIT;
