-- Self-check for 0008_change_approvals.sql. Runs as workbeat_api in one transaction that is rolled back.
BEGIN;
SET ROLE workbeat_api;

CREATE FUNCTION pg_temp.ok(cond bool, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF; RAISE NOTICE 'ok  %', what; END $$;

SET LOCAL app.scope = 'system';
INSERT INTO companies (id, name, slug, uninstall_token_hash, uninstall_token_ciphertext, notice_text) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Acme', 'acme', 'u1', '\x00', 'notice'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Other', 'other', 'u2', '\x00', 'notice');
INSERT INTO users (id, email, name, role, company_id, password_hash) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'it@acme.test', 'IT', 'it_admin', 'aaaaaaaa-0000-0000-0000-000000000001', 'h');
INSERT INTO changes (company_id, resource, action, summary, method, path, requested_by) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'block_rule', 'create', 'Block website x.com', 'POST', '/v1/block-rules', 'aaaaaaaa-0000-0000-0000-0000000000a1');

DO $$ BEGIN
  BEGIN
    UPDATE changes SET status = 'approved';
    RAISE EXCEPTION 'FAIL: a decided change without decided_at was accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok  a decision needs decided_at';
  END;
  BEGIN
    UPDATE changes SET status = 'failed', decided_at = now();
    RAISE EXCEPTION 'FAIL: a failed change without error was accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok  a failed change carries its error';
  END;
END $$;

SET LOCAL app.scope = 'tenant';
SET LOCAL app.company_id = 'bbbbbbbb-0000-0000-0000-000000000001';
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM changes), 'another company sees no change');
SET LOCAL app.company_id = 'aaaaaaaa-0000-0000-0000-000000000001';
SELECT pg_temp.ok((SELECT count(*) = 1 FROM changes), 'the company sees its change');
SET LOCAL app.scope = 'staff';
SET LOCAL app.company_id = '';
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM changes), 'staff see no change');

ROLLBACK;
