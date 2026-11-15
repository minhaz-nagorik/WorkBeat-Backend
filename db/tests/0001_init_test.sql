-- Self-check for 0001_init.sql. Run on a scratch database after the migration:
--   psql -v ON_ERROR_STOP=1 -f db/migrations/0001_init.sql -f db/tests/0001_init_test.sql
-- Everything runs as workbeat_api inside one transaction that is rolled back.

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

-- ---------------------------------------------------------------- seed (system scope)
SET LOCAL app.scope = 'system';
INSERT INTO companies (id, name, slug, status, uninstall_token_hash, uninstall_token_ciphertext, notice_text) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Acme', 'acme', 'active', 'u1', '\x00', 'notice'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Beta', 'beta', 'active', 'u2', '\x00', 'notice');
INSERT INTO licenses (company_id, key_hash, key_ciphertext, key_last4, plan, seat_limit, screenshot_tier) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'keyA', '\x00', 'AAAA', 'starter', 2, 'standard'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'keyB', '\x00', 'BBBB', 'growth', 50, 'off');
INSERT INTO users (id, email, name, role, company_id) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'admin@acme.test', 'Admin', 'company_admin', 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('99999999-0000-0000-0000-000000000001', 'ops@workbeat.test', 'Ops', 'super_admin', NULL);
INSERT INTO employees (id, company_id, name) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Nusrat'),
  ('aaaaaaaa-0000-0000-0000-0000000000e2', 'aaaaaaaa-0000-0000-0000-000000000001', 'Arif'),
  ('bbbbbbbb-0000-0000-0000-0000000000e1', 'bbbbbbbb-0000-0000-0000-000000000001', 'Other');

SELECT pg_temp.ok((SELECT screenshot_interval_seconds FROM employee_monitoring_settings
  WHERE employee_id = 'aaaaaaaa-0000-0000-0000-0000000000e1') = 1800, 'new employee gets settings at the company tier');

SELECT pg_temp.raises($$INSERT INTO users (id, email, name, role, company_id) VALUES
  (gen_random_uuid(), 'x@x.test', 'X', 'super_admin', 'aaaaaaaa-0000-0000-0000-000000000001')$$,
  'users_check', 'a super admin cannot belong to a company');

SELECT pg_temp.raises($$UPDATE employee_monitoring_settings SET screenshot_interval_seconds = 900$$,
  'screenshot_interval_seconds', 'screenshot interval limited to 0/600/1800/3600');

-- ---------------------------------------------------------------- seats (D43), seat limit 2
INSERT INTO devices (id, company_id, employee_id, key_hash, hostname, os, os_version, arch, hardware_id, agent_version) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'dk1', 'h1', 'macos', '14', 'arm64', 'HW1', '1.0.0'),
  ('aaaaaaaa-0000-0000-0000-0000000000d2', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e2', 'dk2', 'h2', 'windows', '11', 'x64', 'HW2', '1.0.0');

SELECT pg_temp.raises($$INSERT INTO devices (company_id, employee_id, key_hash, hostname, os, os_version, arch, hardware_id, agent_version)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'dk3', 'h3', 'macos', '14', 'arm64', 'HW3', '1.0.0')$$,
  'SEAT_LIMIT_EXCEEDED', 'third device refused at 2/2 seats');

UPDATE devices SET released_at = now() WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000d1';
INSERT INTO devices (id, company_id, employee_id, key_hash, hostname, os, os_version, arch, hardware_id, agent_version)
  VALUES ('aaaaaaaa-0000-0000-0000-0000000000d3', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'dk3', 'h3', 'macos', '14', 'arm64', 'HW3', '1.0.0');
SELECT pg_temp.ok(true, 'release frees the seat; the key installs another device');

-- A released device re-enrolls as a new row, and needs a seat again.
SELECT pg_temp.raises($$INSERT INTO devices (company_id, employee_id, key_hash, hostname, os, os_version, arch, hardware_id, agent_version)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'dk1b', 'h1', 'macos', '14', 'arm64', 'HW1', '1.0.0')$$,
  'SEAT_LIMIT_EXCEEDED', 'released hardware re-enrolling takes a seat');
UPDATE devices SET deactivated_at = now(), key_hash = NULL WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000d3';
INSERT INTO devices (company_id, employee_id, key_hash, hostname, os, os_version, arch, hardware_id, agent_version)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'dk1b', 'h1', 'macos', '14', 'arm64', 'HW1', '1.0.0');
SELECT pg_temp.ok((SELECT count(*) FROM devices WHERE hardware_id = 'HW1') = 2, 'released hardware comes back as a new row');

SELECT pg_temp.raises($$UPDATE devices SET deactivated_at = NULL, key_hash = 'dk3b' WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000d3'$$,
  'SEAT_LIMIT_EXCEEDED', 'reactivating a deactivated device needs a free seat');

SELECT pg_temp.raises($$INSERT INTO devices (company_id, employee_id, key_hash, hostname, os, os_version, arch, hardware_id, agent_version, deactivated_at)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', NULL, 'h2', 'windows', '11', 'x64', 'HW2', '1.0.0', now())$$,
  'devices_hardware', 'same hardware cannot have two unreleased rows');

-- Key reissue changes only the key: seats are unchanged.
UPDATE licenses SET key_hash = 'keyA2', key_last4 = 'ZZZZ', key_reset_at = now() WHERE company_id = 'aaaaaaaa-0000-0000-0000-000000000001';
SELECT pg_temp.ok((SELECT count(*) FROM devices WHERE company_id = 'aaaaaaaa-0000-0000-0000-000000000001'
  AND deactivated_at IS NULL AND released_at IS NULL) = 2, 'reissued key keeps 2/2 seats');
SELECT pg_temp.ok((SELECT count(*) FROM auth_license('keyA')) = 0 AND (SELECT count(*) FROM auth_license('keyA2')) = 1, 'old key refused, new key accepted');
SELECT pg_temp.ok((SELECT released FROM auth_device('dk1')), 'released device key resolves as released (401 DEVICE_RELEASED)');

-- ---------------------------------------------------------------- every device has an employee (D44)
SELECT pg_temp.raises($$INSERT INTO devices (company_id, key_hash, hostname, os, os_version, arch, hardware_id, agent_version, deactivated_at)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001', NULL, 'h9', 'macos', '14', 'arm64', 'HW9', '1.0.0', now())$$,
  'employee_id', 'a device without an employee is refused');
SELECT pg_temp.raises($$UPDATE employees SET archived_at = now() WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000e2'$$,
  'EMPLOYEE_HAS_DEVICES', 'an employee with an unreleased device cannot be removed');
SAVEPOINT s1;
UPDATE devices SET released_at = now() WHERE employee_id = 'aaaaaaaa-0000-0000-0000-0000000000e2';
UPDATE employees SET archived_at = now() WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000e2';
SELECT pg_temp.ok(true, 'after release the employee can be removed');
ROLLBACK TO SAVEPOINT s1;

-- ---------------------------------------------------------------- policy version only grows
CREATE TEMP TABLE v AS SELECT greatest(c.policy_version, s.policy_version, d.policy_version) AS before
  FROM devices d JOIN companies c ON c.id = d.company_id JOIN employee_monitoring_settings s ON s.employee_id = d.employee_id
 WHERE d.id = 'aaaaaaaa-0000-0000-0000-0000000000d2';
UPDATE devices SET employee_id = 'aaaaaaaa-0000-0000-0000-0000000000e1' WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000d2';
SELECT pg_temp.ok((SELECT greatest(c.policy_version, s.policy_version, d.policy_version)
  FROM devices d JOIN companies c ON c.id = d.company_id JOIN employee_monitoring_settings s ON s.employee_id = d.employee_id
 WHERE d.id = 'aaaaaaaa-0000-0000-0000-0000000000d2') > (SELECT before FROM v), 'reassigning a device raises its policy version');

UPDATE v SET before = (SELECT policy_version FROM employee_monitoring_settings WHERE employee_id = 'aaaaaaaa-0000-0000-0000-0000000000e1');
INSERT INTO monitoring_pauses (company_id, employee_id, starts_at, ends_at, reason, created_by) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', now(), now() + interval '1 day', 'annual_leave', 'aaaaaaaa-0000-0000-0000-0000000000a1');
SELECT pg_temp.ok((SELECT policy_version FROM employee_monitoring_settings WHERE employee_id = 'aaaaaaaa-0000-0000-0000-0000000000e1') > (SELECT before FROM v), 'a pause raises the employee policy version');

UPDATE v SET before = (SELECT policy_version FROM companies WHERE slug = 'acme');
INSERT INTO block_rules (company_id, type, pattern) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'domain', 'facebook.com');
SELECT pg_temp.ok((SELECT policy_version FROM companies WHERE slug = 'acme') > (SELECT before FROM v), 'a block rule raises the company policy version');
SELECT pg_temp.raises($$INSERT INTO block_rules (company_id, type, pattern) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'regex', '.*')$$,
  'block_rules_type_check', 'regex block rules refused (D39)');

-- ---------------------------------------------------------------- partitions
INSERT INTO app_sessions (company_id, device_id, employee_id, batch_id, os_user, bundle_id, app_name, process_name, started_at, ended_at, duration_seconds)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000d2', 'aaaaaaaa-0000-0000-0000-0000000000e1',
          gen_random_uuid(), 'nusrat', 'com.apple.Safari', 'Safari', 'Safari', now(), now(), 30);
SELECT pg_temp.ok(true, 'activity row lands in this month''s partition');
SELECT pg_temp.raises($$SELECT count(*) FROM app_sessions_$$ || to_char(now(), 'YYYYMM'),
  'permission denied', 'API cannot read a partition directly, bypassing RLS');

-- ---------------------------------------------------------------- tenant isolation (Plan §6.1)
SET LOCAL app.scope = 'tenant';
SET LOCAL app.company_id = 'bbbbbbbb-0000-0000-0000-000000000001';
SELECT pg_temp.ok((SELECT count(*) FROM employees) = 1, 'tenant B sees only its own employee');
SELECT pg_temp.ok((SELECT count(*) FROM devices) = 0 AND (SELECT count(*) FROM app_sessions) = 0, 'tenant B sees no Acme devices or activity');
SELECT pg_temp.ok((SELECT count(*) FROM companies) = 1, 'tenant B sees only its own company');
SELECT pg_temp.raises($$INSERT INTO block_rules (company_id, type, pattern) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'domain', 'x.com')$$,
  'row-level security', 'tenant B cannot write into Acme');

SET LOCAL app.company_id = '';
SELECT pg_temp.ok((SELECT count(*) FROM employees) = 0, 'no tenant context sees nothing');

-- ---------------------------------------------------------------- staff (D41)
SET LOCAL app.scope = 'staff';
SELECT pg_temp.ok((SELECT count(*) FROM companies) = 2 AND (SELECT count(*) FROM licenses) = 2, 'staff see every company and licence');
SELECT pg_temp.ok((SELECT count(*) FROM employees) + (SELECT count(*) FROM devices) + (SELECT count(*) FROM app_sessions)
  + (SELECT count(*) FROM url_visits) + (SELECT count(*) FROM screenshots) = 0, 'staff see no employee, device or activity data');

-- ---------------------------------------------------------------- retention helpers
RESET ROLE;
SELECT pg_temp.ok(drop_old_partitions(365) = 0, 'no partition is old enough to drop');
SELECT pg_temp.ok(drop_old_partitions(0) = 4, 'last month''s partitions drop when past the limit');

ROLLBACK;
