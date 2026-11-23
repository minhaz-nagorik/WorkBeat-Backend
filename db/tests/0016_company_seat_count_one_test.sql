-- Self-check for 0016_company_seat_count_one.sql. Run after every migration:
--   psql -v ON_ERROR_STOP=1 -f db/tests/0016_company_seat_count_one_test.sql
-- Runs as workbeat_api in one transaction that is rolled back.

BEGIN;
SET ROLE workbeat_api;

CREATE FUNCTION pg_temp.ok(cond bool, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF; RAISE NOTICE 'ok  %', what; END $$;

SET LOCAL app.scope = 'system';
INSERT INTO companies (id, name, slug, status, uninstall_token_hash, uninstall_token_ciphertext, notice_text) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000161', 'A', 'a-16', 'active', 'u161', '\x00', 'n'),
  ('aaaaaaaa-0000-0000-0000-000000000162', 'B', 'b-16', 'active', 'u162', '\x00', 'n');
INSERT INTO licenses (company_id, key_hash, key_ciphertext, key_last4, plan, seat_limit) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000161', 'k161', '\x00', 'AAAA', 'starter', 5),
  ('aaaaaaaa-0000-0000-0000-000000000162', 'k162', '\x00', 'AAAA', 'starter', 5);
INSERT INTO employees (id, company_id, name, email) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000016e1', 'aaaaaaaa-0000-0000-0000-000000000161', 'E', 'e16@test.example');
INSERT INTO devices (company_id, employee_id, key_hash, hostname, os, os_version, arch, hardware_id, agent_version) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000161', 'aaaaaaaa-0000-0000-0000-0000000016e1', 'k16a', 'h1', 'macos', '14', 'arm64', 'HW16A', '1.0.0'),
  ('aaaaaaaa-0000-0000-0000-000000000161', 'aaaaaaaa-0000-0000-0000-0000000016e1', 'k16b', 'h2', 'macos', '14', 'arm64', 'HW16B', '1.0.0');
UPDATE devices SET released_at = now() WHERE hardware_id = 'HW16B';

SELECT pg_temp.ok((SELECT array_agg(company_id) FROM company_seat_counts('aaaaaaaa-0000-0000-0000-000000000161'))
                  = ARRAY['aaaaaaaa-0000-0000-0000-000000000161'::uuid], 'one company in, one row out');
SELECT pg_temp.ok((SELECT seats_used FROM company_seat_counts('aaaaaaaa-0000-0000-0000-000000000161')) = 1, 'a released device frees its seat');
SELECT pg_temp.ok((SELECT seats_used FROM company_seat_counts('aaaaaaaa-0000-0000-0000-000000000162')) = 0, 'no devices counts 0');
SELECT pg_temp.ok((SELECT count(*) FROM company_seat_counts() WHERE company_id IN
                   ('aaaaaaaa-0000-0000-0000-000000000161', 'aaaaaaaa-0000-0000-0000-000000000162')) = 2, 'no argument: every company');

SET LOCAL app.scope = 'tenant';
SET LOCAL app.company_id = 'aaaaaaaa-0000-0000-0000-000000000161';
DO $$ BEGIN
  PERFORM company_seat_counts('aaaaaaaa-0000-0000-0000-000000000162');
  RAISE EXCEPTION 'FAIL: tenant scope may not count seats';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
  RAISE NOTICE 'ok  tenant scope is refused';
END $$;

ROLLBACK;
