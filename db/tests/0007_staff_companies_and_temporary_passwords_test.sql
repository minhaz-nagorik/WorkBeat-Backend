-- Self-check for 0007_staff_companies_and_temporary_passwords.sql. Runs as workbeat_api in one transaction that is rolled back.
BEGIN;
SET ROLE workbeat_api;

CREATE FUNCTION pg_temp.ok(cond bool, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF; RAISE NOTICE 'ok  %', what; END $$;

SET LOCAL app.scope = 'staff';
INSERT INTO companies (id, name, slug, uninstall_token_hash, uninstall_token_ciphertext, notice_text) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Acme', 'acme', 'u1', '\x00', 'notice');
SELECT company_defaults('aaaaaaaa-0000-0000-0000-000000000001');
SELECT company_defaults('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO users (id, email, name, role, company_id, password_hash, must_change_password, password_expires_at) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'ada@acme.test', 'Ada', 'company_admin', 'aaaaaaaa-0000-0000-0000-000000000001', 'h', true, now() + interval '72 hours');
INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ('aaaaaaaa-0000-0000-0000-0000000000a1', 'tok', now() + interval '1 day');

DO $$ BEGIN
  BEGIN
    UPDATE users SET must_change_password = false WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000a1';
    RAISE EXCEPTION 'FAIL: an expiry without a temporary password was accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok  an expiry needs a temporary password';
  END;
END $$;

SET LOCAL app.scope = 'system';
SELECT pg_temp.ok((SELECT count(*) = 5 FROM sensitive_domains WHERE company_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'defaults are added once');
RESET app.scope;
SELECT pg_temp.ok((SELECT must_change_password AND password_expires_at > now() FROM auth_login('ada@acme.test')), 'login reports a temporary password');
SELECT pg_temp.ok((SELECT must_change_password FROM auth_session('tok')), 'the session guard sees it too');
DO $$ BEGIN
  BEGIN
    PERFORM company_defaults('aaaaaaaa-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'FAIL: company_defaults ran without a scope';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'FORBIDDEN' THEN RAISE; END IF;
    RAISE NOTICE 'ok  company_defaults needs staff or system scope';
  END;
END $$;

ROLLBACK;
