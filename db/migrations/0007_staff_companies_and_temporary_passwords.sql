-- WorkBeat backend — staff create companies; staff reissue a Company Admin's password as a
-- temporary one (admin round 5, product owner 17 Nov 2026).
-- Self-check: db/tests/0007_staff_companies_and_temporary_passwords_test.sql.

BEGIN;

-- A temporary password works until password_expires_at and must be replaced at sign-in.
ALTER TABLE users ADD COLUMN must_change_password bool NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN password_expires_at timestamptz;
ALTER TABLE users ADD CONSTRAINT users_temporary_password CHECK (must_change_password OR password_expires_at IS NULL);

DROP FUNCTION auth_login(citext);
CREATE FUNCTION auth_login(p_email citext)
RETURNS TABLE (user_id uuid, password_hash text, company_id uuid, role text, must_change_password bool, password_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, password_hash, company_id, role, must_change_password, password_expires_at FROM users WHERE email = p_email AND disabled_at IS NULL
$$;

DROP FUNCTION auth_session(text);
CREATE FUNCTION auth_session(p_token_hash text)
RETURNS TABLE (session_id uuid, user_id uuid, company_id uuid, role text, email citext, name text, must_change_password bool)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, u.id, u.company_id, u.role, u.email, u.name, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id
   WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now() AND u.disabled_at IS NULL
$$;

-- A new company's default sensitive domains. Staff create companies but have no tenant access (D41),
-- so this one write runs as the owner; it reads nothing back.
CREATE FUNCTION company_defaults(p_company_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF app_scope() NOT IN ('staff', 'system') THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO sensitive_domains (company_id, pattern, is_default)
  SELECT p_company_id, p, true FROM unnest(ARRAY['chase.com', 'paypal.com', 'mail.google.com', 'outlook.live.com', 'mychart.com']) p
  ON CONFLICT DO NOTHING;
END $$;

REVOKE ALL ON FUNCTION auth_login(citext), auth_session(text), company_defaults(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_login(citext), auth_session(text), company_defaults(uuid) TO workbeat_api;

COMMIT;
