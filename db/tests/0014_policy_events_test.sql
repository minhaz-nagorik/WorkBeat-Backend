-- Self-check for 0014_policy_events.sql. Run after every migration:
--   psql -v ON_ERROR_STOP=1 -f db/tests/0014_policy_events_test.sql
-- Runs as workbeat_api in one transaction that is rolled back. NOTIFY is only delivered on commit,
-- so this checks the triggers and their conditions, and that firing them does not fail.

BEGIN;
SET ROLE workbeat_api;

CREATE FUNCTION pg_temp.ok(cond bool, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF; RAISE NOTICE 'ok  %', what; END $$;

CREATE FUNCTION pg_temp.trig(t text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = t AND NOT tgisinternal $$;

SELECT pg_temp.ok(pg_temp.trig('companies_policy_event') LIKE '%AFTER UPDATE ON public.companies%'
                  AND pg_temp.trig('companies_policy_event') LIKE '%IS DISTINCT FROM%', 'a company version change notifies');
SELECT pg_temp.ok(pg_temp.trig('settings_policy_event') LIKE '%employee_monitoring_settings%'
                  AND pg_temp.trig('settings_policy_event') LIKE '%''e'', ''employee_id''%', 'a settings change notifies the employee');
SELECT pg_temp.ok(pg_temp.trig('devices_policy_event') LIKE '%released_at%'
                  AND pg_temp.trig('devices_policy_event') LIKE '%key_hash%', 'a release or key change notifies the device');

SET LOCAL app.scope = 'system';
INSERT INTO companies (id, name, slug, status, uninstall_token_hash, uninstall_token_ciphertext, notice_text) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000014', 'Acme', 'acme-14', 'active', 'u1', '\x00', 'notice');
INSERT INTO licenses (company_id, key_hash, key_ciphertext, key_last4, plan, seat_limit) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000014', 'key14', '\x00', 'AAAA', 'starter', 5);
INSERT INTO employees (id, company_id, name, email) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000014e1', 'aaaaaaaa-0000-0000-0000-000000000014', 'Karim', 'karim14@test.example');
INSERT INTO devices (id, company_id, employee_id, key_hash, hostname, os, os_version, arch, hardware_id, agent_version) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000014d1', 'aaaaaaaa-0000-0000-0000-000000000014', 'aaaaaaaa-0000-0000-0000-0000000014e1',
   'k14', 'lt-014', 'macos', '13', 'arm64', 'DEV-14', '1.0.0');

UPDATE companies SET policy_version = nextval('policy_version_seq') WHERE id = 'aaaaaaaa-0000-0000-0000-000000000014';
UPDATE employee_monitoring_settings SET policy_version = nextval('policy_version_seq')
 WHERE employee_id = 'aaaaaaaa-0000-0000-0000-0000000014e1';
UPDATE devices SET key_hash = 'k14b' WHERE id = 'aaaaaaaa-0000-0000-0000-0000000014d1';
SELECT pg_temp.ok(true, 'the three triggers fire without error');

ROLLBACK;
