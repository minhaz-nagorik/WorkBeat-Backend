-- Self-check for 0004_portal_auth.sql. Runs as workbeat_api in one transaction that is rolled back.
BEGIN;
SET ROLE workbeat_api;

CREATE FUNCTION pg_temp.ok(cond bool, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF; RAISE NOTICE 'ok  %', what; END $$;

SET LOCAL app.scope = 'system';
INSERT INTO companies (id, name, slug, uninstall_token_hash, uninstall_token_ciphertext, notice_text) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Acme', 'acme', 'u1', '\x00', 'notice'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Beta', 'beta', 'u2', '\x00', 'notice');
INSERT INTO users (id, email, name, role, company_id, password_hash) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'ada@acme.test', 'Ada', 'company_admin', 'aaaaaaaa-0000-0000-0000-000000000001', 'h'),
  ('aaaaaaaa-0000-0000-0000-0000000000a2', 'gone@acme.test', 'Gone', 'manager', 'aaaaaaaa-0000-0000-0000-000000000001', 'h');
INSERT INTO users (email, name, role, company_id) VALUES ('new@beta.test', 'New', 'it_admin', 'bbbbbbbb-0000-0000-0000-000000000001');
SELECT pg_temp.ok((SELECT id IS NOT NULL FROM users WHERE email = 'new@beta.test'), 'users.id defaults to a new uuid');

INSERT INTO sessions (user_id, token_hash, expires_at) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'live', now() + interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'old', now() - interval '1 second'),
  ('aaaaaaaa-0000-0000-0000-0000000000a2', 'disabled', now() + interval '1 day');
INSERT INTO sessions (user_id, token_hash, expires_at, revoked_at) VALUES
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'revoked', now() + interval '1 day', now());
UPDATE users SET disabled_at = now() WHERE id = 'aaaaaaaa-0000-0000-0000-0000000000a2';

RESET app.scope;
SELECT pg_temp.ok((SELECT company_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND role = 'company_admin' FROM auth_session('live')), 'a live session resolves to its user and company');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM auth_session('old')), 'an expired session is refused');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM auth_session('revoked')), 'a revoked session is refused');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM auth_session('disabled')), 'a disabled user''s session is refused');
SELECT pg_temp.ok((SELECT password_hash = 'h' FROM auth_login('ADA@acme.test')), 'login lookup is case-insensitive');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM auth_login('gone@acme.test')), 'a disabled user cannot log in');
SELECT pg_temp.ok(email_has_user('new@beta.test') AND NOT email_has_user('nobody@x.test'), 'email_has_user sees every company');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM users), 'without a scope no user row is readable');

ROLLBACK;
