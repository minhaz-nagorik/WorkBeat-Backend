-- Self-check for 0006_staff_api_and_cleanup.sql. Runs as workbeat_api in one transaction that is rolled back.
BEGIN;
SET ROLE workbeat_api;

CREATE FUNCTION pg_temp.ok(cond bool, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF; RAISE NOTICE 'ok  %', what; END $$;

SET LOCAL app.scope = 'system';
INSERT INTO companies (id, name, slug, uninstall_token_hash, uninstall_token_ciphertext, notice_text) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Acme', 'acme', 'u1', '\x00', 'notice');
INSERT INTO users (id, email, name, role, company_id, password_hash) VALUES
  ('bbbbbbbb-0000-0000-0000-0000000000a1', 'ops@workbeat.test', 'Ops', 'super_admin', NULL, 'h');

INSERT INTO agent_releases (product, platform, arch, version, min_supported, storage_path, sha256, signature, size_bytes, published_by)
  VALUES ('agent', 'windows', 'x64', '1.0.0', '1.0.0', 'a/1.msi', 'x', NULL, 1, 'bbbbbbbb-0000-0000-0000-0000000000a1');
SELECT pg_temp.ok(true, 'an unsigned Windows release is accepted');

DO $$ BEGIN
  BEGIN
    INSERT INTO agent_releases (product, platform, arch, version, min_supported, storage_path, sha256, signature, size_bytes, published_by)
      VALUES ('agent', 'macos', 'universal', '1.0.0', '1.0.0', 'a/1.pkg', 'x', NULL, 1, 'bbbbbbbb-0000-0000-0000-0000000000a1');
    RAISE EXCEPTION 'FAIL: an unsigned macOS release was accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok  a macOS release needs a signature';
  END;
  BEGIN
    INSERT INTO agent_releases (product, platform, arch, version, min_supported, storage_path, sha256, signature, size_bytes, published_by)
      VALUES ('agent', 'windows', 'arm64', '1.0.0', '1.0.0', 'a/2.msi', 'x', '', 1, 'bbbbbbbb-0000-0000-0000-0000000000a1');
    RAISE EXCEPTION 'FAIL: an empty signature was accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok  an empty signature is refused';
  END;
  BEGIN
    INSERT INTO employees (company_id, name) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'No Email');
    RAISE EXCEPTION 'FAIL: an employee without an email was accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok  a non-archived employee needs an email';
  END;
END $$;

SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name LIKE 'mfa%'), 'MFA columns are gone');
SELECT pg_temp.ok(to_regclass('mfa_challenges') IS NULL, 'mfa_challenges is gone');
RESET app.scope;
SELECT pg_temp.ok((SELECT role = 'super_admin' FROM auth_login('ops@workbeat.test')), 'login still resolves a user');

ROLLBACK;
