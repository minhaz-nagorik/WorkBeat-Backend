-- Self-check for 0013_custom_roles.sql. Runs as workbeat_api in one transaction that is rolled back.
BEGIN;
SET ROLE workbeat_api;

CREATE FUNCTION pg_temp.ok(cond bool, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF; RAISE NOTICE 'ok  %', what; END $$;

SET LOCAL app.scope = 'system';
INSERT INTO companies (id, name, slug, uninstall_token_hash, uninstall_token_ciphertext, notice_text) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000013', 'Acme13', 'acme13', 'u13', '\x00', 'notice'),
  ('bbbbbbbb-0000-0000-0000-000000000013', 'Other13', 'other13', 'v13', '\x00', 'notice');
INSERT INTO roles (id, company_id, name, permissions, team_only) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000013a0', 'aaaaaaaa-0000-0000-0000-000000000013', 'Auditor', '{reports,employees.view}', true),
  ('bbbbbbbb-0000-0000-0000-0000000013b0', 'bbbbbbbb-0000-0000-0000-000000000013', 'Auditor', '{}', false);
INSERT INTO users (id, email, name, role, role_id, company_id, password_hash) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000013a1', 'aud@acme13.test', 'Aud', 'member', 'aaaaaaaa-0000-0000-0000-0000000013a0', 'aaaaaaaa-0000-0000-0000-000000000013', 'h');

DO $$ BEGIN
  BEGIN
    INSERT INTO roles (company_id, name) VALUES ('aaaaaaaa-0000-0000-0000-000000000013', 'AUDITOR');
    RAISE EXCEPTION 'FAIL: a second role with the same name was accepted';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok  role names are unique per company, any case';
  END;
  BEGIN
    INSERT INTO roles (company_id, name, permissions) VALUES ('aaaaaaaa-0000-0000-0000-000000000013', 'Bad', '{billing}');
    RAISE EXCEPTION 'FAIL: an unknown permission was accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok  only known permissions';
  END;
  BEGIN
    INSERT INTO users (id, email, name, role, company_id, password_hash)
    VALUES (gen_random_uuid(), 'x@acme13.test', 'X', 'member', 'aaaaaaaa-0000-0000-0000-000000000013', 'h');
    RAISE EXCEPTION 'FAIL: an enabled member without a role was accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok  an enabled member has a role';
  END;
  BEGIN
    INSERT INTO users (id, email, name, role, company_id, password_hash)
    VALUES (gen_random_uuid(), 'it@acme13.test', 'IT', 'it_admin', 'aaaaaaaa-0000-0000-0000-000000000013', 'h');
    RAISE EXCEPTION 'FAIL: the old it_admin role was accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok  it_admin and manager are gone';
  END;
  BEGIN
    INSERT INTO users (id, email, name, role, role_id, company_id, password_hash)
    VALUES (gen_random_uuid(), 'y@acme13.test', 'Y', 'member', 'bbbbbbbb-0000-0000-0000-0000000013b0', 'aaaaaaaa-0000-0000-0000-000000000013', 'h');
    RAISE EXCEPTION 'FAIL: a role of another company was accepted';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'ok  a user''s role is of their own company';
  END;
END $$;

INSERT INTO changes (company_id, resource, action, summary, method, path, requested_by) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000013', 'role', 'create', 'Create the role X', 'POST', '/v1/roles', 'aaaaaaaa-0000-0000-0000-0000000013a1');
SELECT pg_temp.ok(true, 'a change may concern a role');

SET LOCAL app.scope = 'tenant';
SET LOCAL app.company_id = 'aaaaaaaa-0000-0000-0000-000000000013';
SELECT pg_temp.ok((SELECT count(*) FROM roles) = 1, 'a company sees only its own roles');
SELECT pg_temp.ok((SELECT alert_email -> 'roles' = '["company_admin"]' FROM companies WHERE id = 'aaaaaaaa-0000-0000-0000-000000000013'),
                  'a new company emails alerts to Company Admins');

ROLLBACK;
