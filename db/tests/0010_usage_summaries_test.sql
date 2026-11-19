-- Self-check for 0010_usage_summaries.sql. Runs as workbeat_api in one transaction that is rolled back.
BEGIN;
SET ROLE workbeat_api;

CREATE FUNCTION pg_temp.ok(cond bool, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF; RAISE NOTICE 'ok  %', what; END $$;

SET LOCAL app.scope = 'system';
INSERT INTO companies (id, name, slug, uninstall_token_hash, uninstall_token_ciphertext, notice_text) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Acme', 'acme', 'u1', '\x00', 'notice'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Beta', 'beta', 'u2', '\x00', 'notice');
INSERT INTO usage_days (company_id, day) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '2026-11-18'), ('bbbbbbbb-0000-0000-0000-000000000001', '2026-11-18');
INSERT INTO usage_hours (company_id, employee_id, day, hour, tracked_seconds, sessions, idle_seconds) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', '2026-11-18', 9, 1800, 1, 12.5),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000e1', '2026-11-18', 9, 600, 1, 0);
INSERT INTO usage_apps (company_id, employee_id, day, app_name, seconds) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', '2026-11-18', 'Code', 1800);
INSERT INTO usage_domains (company_id, employee_id, day, domain, seconds) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000e1', '2026-11-18', 'example.com', 600);
SELECT pg_temp.ok((SELECT count(*) FROM usage_days) = 2, 'system scope sees every company');

DO $$ BEGIN
  INSERT INTO usage_hours (company_id, employee_id, day, hour) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000e1', '2026-11-18', 24);
  RAISE EXCEPTION 'FAIL: hour 24 accepted';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok  hour 24 refused';
END $$;

SET LOCAL app.scope = 'tenant';
SET LOCAL app.company_id = 'aaaaaaaa-0000-0000-0000-000000000001';
SELECT pg_temp.ok((SELECT count(*) FROM usage_days) = 1 AND (SELECT count(*) FROM usage_hours) = 1
  AND (SELECT count(*) FROM usage_apps) = 1 AND (SELECT count(*) FROM usage_domains) = 0, 'a tenant sees only its own summaries');
SELECT pg_temp.ok((SELECT idle_seconds FROM usage_hours) = 12.5, 'idle seconds keep fractions');
DO $$ BEGIN
  INSERT INTO usage_days (company_id, day) VALUES ('bbbbbbbb-0000-0000-0000-000000000001', '2026-11-17');
  RAISE EXCEPTION 'FAIL: a tenant wrote another company''s summary';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok  a tenant cannot write another company''s summary';
END $$;

SET LOCAL app.scope = 'staff';
SET LOCAL app.company_id = '';
SELECT pg_temp.ok((SELECT count(*) FROM usage_hours) = 0 AND (SELECT count(*) FROM usage_apps) = 0, 'staff see no summary (D41)');

ROLLBACK;
