-- WorkBeat backend — staff MFA (TOTP) and self-service password reset, without Supabase Auth.
-- Staff (super_admin) get a session only after a second factor (D41, Plan v3.5 §4.6).
-- Self-check: db/tests/0005_mfa_and_password_reset_test.sql.

BEGIN;

-- TOTP secret, encrypted by the API (B6). mfa_last_step stops a code being used twice.
ALTER TABLE users ADD COLUMN mfa_secret_ciphertext bytea;
ALTER TABLE users ADD COLUMN mfa_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN mfa_last_step bigint;
ALTER TABLE users ADD CONSTRAINT users_mfa_complete CHECK ((mfa_enabled_at IS NULL) = (mfa_secret_ciphertext IS NULL));

-- Between the password and the second factor: no session yet (global, no tenant data).
CREATE TABLE mfa_challenges (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  token_hash                text NOT NULL UNIQUE,
  pending_secret_ciphertext bytea,           -- set while enrolling a new factor
  attempts                  int  NOT NULL DEFAULT 0,
  expires_at                timestamptz NOT NULL,
  used_at                   timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_challenges_user ON mfa_challenges (user_id) WHERE used_at IS NULL;

CREATE TABLE password_resets (       -- global: requested before anyone is signed in
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user ON password_resets (user_id) WHERE used_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_challenges, password_resets TO workbeat_api;

-- Login now also says whether the user has a second factor.
DROP FUNCTION auth_login(citext);
CREATE FUNCTION auth_login(p_email citext)
RETURNS TABLE (user_id uuid, password_hash text, company_id uuid, role text, mfa_enabled bool)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, password_hash, company_id, role, mfa_enabled_at IS NOT NULL FROM users WHERE email = p_email AND disabled_at IS NULL
$$;

-- An open MFA challenge of an enabled user.
CREATE FUNCTION auth_mfa_challenge(p_token_hash text)
RETURNS TABLE (challenge_id uuid, user_id uuid, attempts int, enrolling bool)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.id, m.user_id, m.attempts, m.pending_secret_ciphertext IS NOT NULL
    FROM mfa_challenges m JOIN users u ON u.id = m.user_id
   WHERE m.token_hash = p_token_hash AND m.used_at IS NULL AND m.expires_at > now() AND u.disabled_at IS NULL
$$;

-- A password-reset token: its user, company and whether it can still be used.
CREATE FUNCTION auth_password_reset(p_token_hash text)
RETURNS TABLE (reset_id uuid, user_id uuid, company_id uuid, role text, usable bool)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id, u.id, u.company_id, u.role, r.used_at IS NULL AND r.expires_at > now() AND u.disabled_at IS NULL
    FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = p_token_hash
$$;

REVOKE ALL ON FUNCTION auth_login(citext), auth_mfa_challenge(text), auth_password_reset(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_login(citext), auth_mfa_challenge(text), auth_password_reset(text) TO workbeat_api;

COMMIT;
