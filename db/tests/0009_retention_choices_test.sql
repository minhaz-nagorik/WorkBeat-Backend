-- Self-check for 0009_retention_choices.sql. Runs as workbeat_api in one transaction that is rolled back.
BEGIN;
SET ROLE workbeat_api;

CREATE FUNCTION pg_temp.ok(cond bool, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF; RAISE NOTICE 'ok  %', what; END $$;

SET LOCAL app.scope = 'system';
INSERT INTO companies (id, name, slug, uninstall_token_hash, uninstall_token_ciphertext, notice_text) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Acme', 'acme', 'u1', '\x00', 'notice');

SELECT pg_temp.ok((SELECT data_retention_days FROM companies WHERE slug = 'acme') = 90, 'a new company keeps 90 days');
UPDATE companies SET data_retention_days = 30 WHERE slug = 'acme';
UPDATE companies SET data_retention_days = 60 WHERE slug = 'acme';
SELECT pg_temp.ok((SELECT data_retention_days FROM companies WHERE slug = 'acme') = 60, '30 and 60 are accepted');

DO $$
DECLARE v int;
BEGIN
  FOREACH v IN ARRAY ARRAY[1, 45, 180, 365] LOOP
    BEGIN
      UPDATE companies SET data_retention_days = v WHERE slug = 'acme';
      RAISE EXCEPTION 'FAIL: retention % was accepted', v;
    EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok  retention % refused', v;
    END;
  END LOOP;
END $$;

ROLLBACK;
