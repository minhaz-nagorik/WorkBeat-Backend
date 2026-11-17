-- Self-check for 0005_mfa_and_password_reset.sql (its MFA part was dropped by 0006; only password resets remain). Runs as workbeat_api in one transaction that is rolled back.
BEGIN;
SET ROLE workbeat_api;

CREATE FUNCTION pg_temp.ok(cond bool, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF; RAISE NOTICE 'ok  %', what; END $$;

SET LOCAL app.scope = 'system';
INSERT INTO companies (id, name, slug, uninstall_token_hash, uninstall_token_ciphertext, notice_text) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Acme', 'acme', 'u1', '\x00', 'notice');
INSERT INTO users (id, email, name, role, company_id, password_hash) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'ada@acme.test', 'Ada', 'company_admin', 'aaaaaaaa-0000-0000-0000-000000000001', 'h'),
  ('bbbbbbbb-0000-0000-0000-0000000000a1', 'ops@workbeat.test', 'Ops', 'super_admin', NULL, 'h');
INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'reset', now() + interval '30 minutes'),
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'stale', now() - interval '1 second');

RESET app.scope;
SELECT pg_temp.ok((SELECT usable AND company_id = 'aaaaaaaa-0000-0000-0000-000000000001' FROM auth_password_reset('reset')), 'a reset token resolves to its user and company');
SELECT pg_temp.ok((SELECT NOT usable FROM auth_password_reset('stale')), 'an expired reset token is not usable');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM users), 'without a scope no user row is readable');

ROLLBACK;
