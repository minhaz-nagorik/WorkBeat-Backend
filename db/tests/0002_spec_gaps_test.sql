-- Self-check for 0002_spec_gaps.sql. Run after 0001 and 0002:
--   psql -v ON_ERROR_STOP=1 -f db/tests/0002_spec_gaps_test.sql
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
INSERT INTO companies (id, name, slug, status, uninstall_token_hash, uninstall_token_ciphertext, notice_text, timezone) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Acme', 'acme', 'active', 'u1', '\x00', 'notice', 'Asia/Dhaka');
INSERT INTO licenses (id, company_id, key_hash, key_ciphertext, key_last4, plan, seat_limit, stripe_customer_id) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001', 'keyA', '\x00', 'AAAA', 'growth', 50, 'cus_123');
INSERT INTO users (id, email, name, role, company_id) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'admin@acme.test', 'Admin', 'company_admin', 'aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO employees (id, company_id, name) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-000000000001', 'Nusrat');
INSERT INTO devices (id, company_id, employee_id, key_hash, hostname, os, os_version, arch, hardware_id, agent_version) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', 'dk1', 'h1', 'macos', '14', 'arm64', 'HW1', '1.0.0');
INSERT INTO enrollment_tokens (company_id, license_id, token_hash, employee_id, expires_at, used_at) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'tUsed', 'aaaaaaaa-0000-0000-0000-0000000000e1', now() + interval '1 day', now()),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'tOld', 'aaaaaaaa-0000-0000-0000-0000000000e1', now() - interval '1 hour', NULL),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'tNew', 'aaaaaaaa-0000-0000-0000-0000000000e1', now() + interval '1 day', NULL);

INSERT INTO employees (id, company_id, name) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000000e2', 'aaaaaaaa-0000-0000-0000-000000000001', 'Arif');
INSERT INTO notice_acknowledgements (company_id, device_id, employee_id, notice_version, acknowledged_at) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-0000000000e1', 3, now()),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-0000000000e2', 3, now());
SELECT pg_temp.ok(true, 'a reassigned device records the new employee''s acknowledgement of the same version');
SELECT pg_temp.raises($$INSERT INTO notice_acknowledgements (company_id, device_id, employee_id, notice_version, acknowledged_at) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-0000000000e1', 3, now())$$,
  'notice_acknowledgements_device_employee_version_key', 'the same employee''s acknowledgement is recorded once');

SELECT pg_temp.raises($$UPDATE companies SET timezone = 'Mars/Base' WHERE slug = 'acme'$$, 'companies_timezone_check', 'unknown timezone refused');
SELECT pg_temp.ok((SELECT jsonb_array_length(alert_email->'types') FROM companies WHERE slug = 'acme') = 6, 'a new company is alerted about every event type');

SELECT pg_temp.ok((SELECT used FROM auth_enrollment_token('tUsed')) AND (SELECT expired FROM auth_enrollment_token('tOld'))
  AND NOT (SELECT used OR expired FROM auth_enrollment_token('tNew')), 'token lookup tells used from expired');
SELECT pg_temp.ok(company_by_host('acme.workbeat.io') = 'aaaaaaaa-0000-0000-0000-000000000001'
  AND company_by_host('ACME.workbeat.io.') = 'aaaaaaaa-0000-0000-0000-000000000001', 'slug host resolves, any case, trailing dot');
SELECT pg_temp.ok(company_by_host('x.acme.workbeat.io') IS NULL AND company_by_host('acme.workbeat.io.evil.com') IS NULL,
  'deeper or look-alike hosts resolve to nothing');
SELECT pg_temp.ok(company_by_stripe_customer('cus_123') = 'aaaaaaaa-0000-0000-0000-000000000001', 'Stripe customer resolves to its company');

INSERT INTO monitoring_pauses (company_id, employee_id, starts_at, ends_at, reason, created_by) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', now(), now() + interval '2 days', 'annual_leave', 'aaaaaaaa-0000-0000-0000-0000000000a1');
SELECT pg_temp.raises($$INSERT INTO monitoring_pauses (company_id, employee_id, starts_at, ends_at, reason, created_by) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', now() + interval '1 day', now() + interval '3 days', 'sick_leave', 'aaaaaaaa-0000-0000-0000-0000000000a1')$$,
  'monitoring_pauses_no_overlap', 'overlapping live pauses refused');
UPDATE monitoring_pauses SET cancelled_at = now();
INSERT INTO monitoring_pauses (company_id, employee_id, starts_at, ends_at, reason, created_by) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', now() + interval '1 day', now() + interval '3 days', 'sick_leave', 'aaaaaaaa-0000-0000-0000-0000000000a1');
SELECT pg_temp.ok(true, 'a cancelled pause no longer blocks a new one');

SELECT pg_temp.raises($$UPDATE employees SET archived_at = now()$$, 'EMPLOYEE_HAS_DEVICES', 'an employee with a seat-holding device cannot be removed');
UPDATE devices SET deactivated_at = now(), key_hash = NULL;
UPDATE employees SET archived_at = now();
SELECT pg_temp.ok(true, 'a deactivated device no longer blocks removing its employee');

-- staff: counts and token deletion without seeing devices or tokens
SET LOCAL app.scope = 'staff';
SELECT pg_temp.ok((SELECT seats_used FROM company_seat_counts() WHERE company_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 0
  AND (SELECT count(*) FROM devices) = 0, 'staff get seat counts but no device rows');
SELECT pg_temp.ok(delete_unused_enrollment_tokens('aaaaaaaa-0000-0000-0000-0000000000c1') = 2, 'reissue deletes only unused tokens');

-- tenant scope cannot reach staff helpers or partition upkeep
SET LOCAL app.scope = 'tenant';
SET LOCAL app.company_id = 'aaaaaaaa-0000-0000-0000-000000000001';
SELECT pg_temp.raises($$SELECT * FROM company_seat_counts()$$, 'FORBIDDEN', 'tenant cannot list every company''s seats');
SELECT pg_temp.raises($$SELECT cron_drop_old_partitions(0)$$, 'FORBIDDEN', 'partition upkeep refused outside system scope');
SELECT pg_temp.raises($$SELECT drop_old_partitions(0)$$, 'permission denied', 'API cannot call the raw partition helper');

SET LOCAL app.scope = 'system';
SELECT pg_temp.ok(cron_drop_old_partitions(365) = 0, 'system scope runs partition upkeep as the owner');

ROLLBACK;
