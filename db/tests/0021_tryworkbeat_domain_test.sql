-- Self-check for 0021_tryworkbeat_domain.sql. Run after all migrations:
--   psql -v ON_ERROR_STOP=1 -f db/tests/0021_tryworkbeat_domain_test.sql
-- Runs as workbeat_api in one transaction that is rolled back.

BEGIN;
SET ROLE workbeat_api;

CREATE FUNCTION pg_temp.ok(cond bool, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF; RAISE NOTICE 'ok  %', what; END $$;

SET LOCAL app.scope = 'system';
INSERT INTO companies (id, name, slug, status, uninstall_token_hash, uninstall_token_ciphertext, notice_text, timezone) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Acme', 'acme', 'active', 'u1', '\x00', 'notice', 'Asia/Dhaka');

SELECT pg_temp.ok(company_by_host('acme.tryworkbeat.com') = 'aaaaaaaa-0000-0000-0000-000000000001'
  AND company_by_host('ACME.tryworkbeat.com.') = 'aaaaaaaa-0000-0000-0000-000000000001', 'slug host resolves, any case, trailing dot');
SELECT pg_temp.ok(company_by_host('x.acme.tryworkbeat.com') IS NULL AND company_by_host('acme.tryworkbeat.com.evil.com') IS NULL,
  'deeper or suffixed hosts do not resolve');
SELECT pg_temp.ok(company_by_host('acme.workbeat.io') IS NULL, 'old workbeat.io host no longer resolves');

ROLLBACK;
