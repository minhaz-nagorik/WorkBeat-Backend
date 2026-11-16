-- Self-check for 0003_device_binding.sql. Run after every migration:
--   psql -v ON_ERROR_STOP=1 -f db/tests/0003_device_binding_test.sql
-- Runs as workbeat_api in one transaction that is rolled back.

BEGIN;
SET ROLE workbeat_api;

CREATE FUNCTION pg_temp.ok(cond bool, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF; RAISE NOTICE 'ok  %', what; END $$;

CREATE FUNCTION pg_temp.raises(stmt text, msg text, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%' || msg || '%' THEN RAISE NOTICE 'ok  %', what; RETURN; END IF;
    RAISE EXCEPTION 'FAIL: % (got: %)', what, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL: % (no error)', what;
END $$;

SET LOCAL app.scope = 'system';
INSERT INTO companies (id, name, slug, status, uninstall_token_hash, uninstall_token_ciphertext, notice_text) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Acme', 'acme', 'active', 'u1', '\x00', 'notice');
INSERT INTO licenses (company_id, key_hash, key_ciphertext, key_last4, plan, seat_limit) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'keyA', '\x00', 'AAAA', 'starter', 5);
INSERT INTO employees (id, company_id, name) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Karim'),
  ('aaaaaaaa-0000-0000-0000-0000000000e2', 'aaaaaaaa-0000-0000-0000-000000000001', 'Nadia');
INSERT INTO devices (id, company_id, employee_id, key_hash, hostname, os, os_version, arch, hardware_id, agent_version) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'kKarim', 'lt-017', 'windows', '11', 'x64', 'DEV-1', '1.0.0');

-- the binding's employee is fixed
SELECT pg_temp.raises($$UPDATE devices SET employee_id = 'aaaaaaaa-0000-0000-0000-0000000000e2'$$,
  'DEVICE_EMPLOYEE_FIXED', 'a binding cannot move to another employee');
UPDATE devices SET employee_id = 'aaaaaaaa-0000-0000-0000-0000000000e1', hostname = 'lt-017b';
SELECT pg_temp.ok(true, 'setting the same employee is allowed');

-- one live binding per device ID: Nadia gets the laptop only after release
SELECT pg_temp.raises($$INSERT INTO devices (company_id, employee_id, key_hash, hostname, os, os_version, arch, hardware_id, agent_version)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e2', 'kNadia', 'lt-017', 'windows', '11', 'x64', 'DEV-1', '1.0.0')$$,
  'devices_hardware', 'a second live binding for the same device ID is refused');

SELECT pg_temp.raises($$UPDATE employees SET archived_at = now() WHERE name = 'Karim'$$, 'EMPLOYEE_HAS_DEVICES', 'Karim cannot be removed while his binding is live');
UPDATE devices SET deactivated_at = now(), key_hash = NULL WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000d1';
SELECT pg_temp.raises($$UPDATE employees SET archived_at = now() WHERE name = 'Karim'$$, 'EMPLOYEE_HAS_DEVICES', 'a deactivated binding still blocks removal');
UPDATE devices SET deactivated_at = NULL, key_hash = 'kKarim' WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000d1';

UPDATE devices SET released_at = now() - interval '2 hours' WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000d1';
SELECT pg_temp.ok((SELECT released AND released_at < now() FROM auth_device('kKarim')), 'released key resolves with released_at for the upload window');

INSERT INTO devices (id, company_id, employee_id, key_hash, hostname, os, os_version, arch, hardware_id, agent_version) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000000d2', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e2', 'kNadia', 'lt-017', 'windows', '11', 'x64', 'DEV-1', '1.0.0');
SELECT pg_temp.ok((SELECT count(*) FROM devices WHERE hardware_id = 'DEV-1') = 2, 'after release the same device ID makes a new binding for Nadia');
SELECT pg_temp.ok((SELECT employee_id FROM auth_device('kKarim')) = 'aaaaaaaa-0000-0000-0000-0000000000e1'
  AND (SELECT employee_id FROM auth_device('kNadia')) = 'aaaaaaaa-0000-0000-0000-0000000000e2', 'each key resolves to its own binding''s employee');
UPDATE employees SET archived_at = now() WHERE name = 'Karim';
SELECT pg_temp.ok(true, 'after release Karim can be removed');

SELECT pg_temp.ok((SELECT alert_email->'types' ? 'duplicate_device_id' FROM companies WHERE slug = 'acme'), 'new companies are alerted about duplicate device IDs');

-- backend-only duplicate device ID alert
INSERT INTO tamper_events (id, company_id, device_id, hostname, event_type, occurred_at) VALUES
  (gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000d2', 'lt-017', 'duplicate_device_id', now());
SELECT pg_temp.ok(true, 'duplicate_device_id is a stored event type');

ROLLBACK;
