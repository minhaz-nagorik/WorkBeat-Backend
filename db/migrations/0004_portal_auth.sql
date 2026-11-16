-- WorkBeat backend — portal sign-in without Supabase Auth (2026-11-16 decision: self-hosted Postgres).
-- Passwords (scrypt, hashed by the API) live on users; sessions are opaque tokens stored as SHA-256,
-- so disabling a user or signing out ends access at once. Self-check: db/tests/0004_portal_auth_test.sql.

BEGIN;

ALTER TABLE users ALTER COLUMN id SET DEFAULT gen_random_uuid();   -- no auth.users to mirror any more
ALTER TABLE users ADD COLUMN password_hash text;

CREATE TABLE sessions (              -- global: resolved before a tenant is known; no tenant data
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_user ON sessions (user_id) WHERE revoked_at IS NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO workbeat_api;

-- Bearer guard: a live session of an enabled user.
CREATE FUNCTION auth_session(p_token_hash text)
RETURNS TABLE (session_id uuid, user_id uuid, company_id uuid, role text, email citext, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, u.id, u.company_id, u.role, u.email, u.name
    FROM sessions s JOIN users u ON u.id = s.user_id
   WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL
$$;

-- Login: the password hash of an enabled user, by email.
CREATE FUNCTION auth_login(p_email citext)
RETURNS TABLE (user_id uuid, password_hash text, company_id uuid, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, password_hash, company_id, role FROM users WHERE email = p_email AND disabled_at IS NULL
$$;

-- Invitations: is this email already a user anywhere (team-invitations "one account per email")?
CREATE FUNCTION email_has_user(p_email citext) RETURNS bool
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM users WHERE email = p_email)
$$;

REVOKE ALL ON FUNCTION auth_session(text), auth_login(citext), email_has_user(citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_session(text), auth_login(citext), email_has_user(citext) TO workbeat_api;

COMMIT;
