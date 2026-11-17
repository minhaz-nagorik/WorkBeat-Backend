-- WorkBeat backend — staff API support and cleanup (admin round 4, 17 Nov 2026).
--   * Windows MSIs are unsigned (W35): agent_releases.signature may be NULL, never ''.
--   * Every non-archived employee has an email (the API requires one since 16 Nov 2026).
--   * Staff MFA was removed (B23): its columns, table and lookup go.
-- Self-check: db/tests/0006_staff_api_and_cleanup_test.sql.

BEGIN;

ALTER TABLE agent_releases ALTER COLUMN signature DROP NOT NULL;
ALTER TABLE agent_releases ADD CONSTRAINT agent_releases_signature_not_empty CHECK (signature <> '');
ALTER TABLE agent_releases ADD CONSTRAINT agent_releases_macos_signed CHECK (platform <> 'macos' OR signature IS NOT NULL);

ALTER TABLE employees ADD CONSTRAINT employees_email_required CHECK (archived_at IS NOT NULL OR email IS NOT NULL);

DROP FUNCTION auth_mfa_challenge(text);
DROP TABLE mfa_challenges;
DROP FUNCTION auth_login(citext);
ALTER TABLE users DROP CONSTRAINT users_mfa_complete;
ALTER TABLE users DROP COLUMN mfa_secret_ciphertext, DROP COLUMN mfa_enabled_at, DROP COLUMN mfa_last_step;

CREATE FUNCTION auth_login(p_email citext)
RETURNS TABLE (user_id uuid, password_hash text, company_id uuid, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, password_hash, company_id, role FROM users WHERE email = p_email AND disabled_at IS NULL
$$;
REVOKE ALL ON FUNCTION auth_login(citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_login(citext) TO workbeat_api;

COMMIT;
