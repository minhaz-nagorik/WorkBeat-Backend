-- Self-check for 0020_slack_alerts.sql. Run after every migration:
--   psql -v ON_ERROR_STOP=1 -f db/tests/0020_slack_alerts_test.sql
-- Runs as workbeat_api in one transaction that is rolled back.

BEGIN;
SET ROLE workbeat_api;

CREATE FUNCTION pg_temp.ok(cond bool, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF; RAISE NOTICE 'ok  %', what; END $$;

SET LOCAL app.scope = 'system';
INSERT INTO companies (id, name, slug, status, uninstall_token_hash, uninstall_token_ciphertext, notice_text) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000200', 'A', 'a-20', 'active', 'u200', '\x00', 'n');
SELECT pg_temp.ok((SELECT slack_webhook_ciphertext IS NULL FROM companies WHERE id = 'aaaaaaaa-0000-0000-0000-000000000200'), 'new company: no Slack webhook');
CREATE TEMP TABLE v AS SELECT policy_version FROM companies WHERE id = 'aaaaaaaa-0000-0000-0000-000000000200';
UPDATE companies SET slack_webhook_ciphertext = '\x01' WHERE id = 'aaaaaaaa-0000-0000-0000-000000000200';
SELECT pg_temp.ok((SELECT c.policy_version = v.policy_version FROM companies c, v WHERE c.id = 'aaaaaaaa-0000-0000-0000-000000000200'),
                  'setting the webhook does not bump the policy version');

ROLLBACK;
