-- WorkBeat backend — device binding model (Plan v3.5, D48).
-- A `devices` row is one binding: the device ID the agent produces + the company's licence + one
-- employee, fixed for the life of the binding. A device goes to someone else only by release and a
-- new enrollment, which is a new row. Doc: docs/core/architecture/data-model.md.
-- Self-check: db/tests/0003_device_binding_test.sql.

BEGIN;

-- A binding's employee never changes (D48). Reassignment and its policy-version bump are gone.
DROP TRIGGER devices_policy ON devices;
DROP FUNCTION devices_policy_bump();

CREATE FUNCTION devices_employee_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.employee_id IS DISTINCT FROM OLD.employee_id THEN
    RAISE EXCEPTION 'DEVICE_EMPLOYEE_FIXED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER devices_employee_fixed BEFORE UPDATE OF employee_id ON devices
  FOR EACH ROW EXECUTE FUNCTION devices_employee_fixed();

-- A released key keeps working on the upload routes for 7 days (D45): the guard needs released_at.
DROP FUNCTION auth_device(text);
CREATE FUNCTION auth_device(p_key_hash text)
RETURNS TABLE (device_id uuid, company_id uuid, employee_id uuid, released bool, released_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, company_id, employee_id, released_at IS NOT NULL, released_at FROM devices WHERE key_hash = p_key_hash
$$;
REVOKE ALL ON FUNCTION auth_device(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_device(text) TO workbeat_api;

-- A device ID enrolling again while its key is live raises a backend-only alert (D46).
ALTER TABLE tamper_events DROP CONSTRAINT tamper_events_event_type_check;
ALTER TABLE tamper_events ADD CONSTRAINT tamper_events_event_type_check CHECK (event_type IN
  ('process_restart', 'hosts_modified', 'config_changed', 'clock_tampered', 'permission_revoked', 'offline', 'duplicate_device_id'));

-- New companies are alerted about duplicate device IDs too.
ALTER TABLE companies ALTER COLUMN alert_email SET DEFAULT
  '{"roles": ["company_admin", "it_admin"], "types": ["process_restart", "hosts_modified", "config_changed", "clock_tampered", "permission_revoked", "offline", "duplicate_device_id"], "delivery": "instant"}';

-- An employee cannot be removed while any binding of theirs is not released (D46, D48).
-- Replaces 0002's rule, which let a deactivated binding through.
CREATE OR REPLACE FUNCTION employees_archive_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL
     AND EXISTS (SELECT 1 FROM devices WHERE employee_id = NEW.id AND released_at IS NULL) THEN
    RAISE EXCEPTION 'EMPLOYEE_HAS_DEVICES' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
