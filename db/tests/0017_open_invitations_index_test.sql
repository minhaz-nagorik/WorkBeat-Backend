-- Self-check for 0017_open_invitations_index.sql. Run after every migration:
--   psql -v ON_ERROR_STOP=1 -f db/tests/0017_open_invitations_index_test.sql
-- Runs as workbeat_api in one transaction that is rolled back. With sequential scans off, the team
-- page's open-invitations query must be an index condition on company_id.

BEGIN;
SET ROLE workbeat_api;

CREATE FUNCTION pg_temp.ok(cond bool, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF; RAISE NOTICE 'ok  %', what; END $$;

CREATE FUNCTION pg_temp.plan(q text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text; o text := '';
BEGIN FOR r IN EXECUTE 'EXPLAIN ' || q LOOP o := o || r || E'\n'; END LOOP; RETURN o; END $$;

SELECT pg_temp.ok(to_regclass('invitations_open_company') IS NOT NULL, 'invitations_open_company exists');

SET LOCAL app.scope = 'tenant';
SET LOCAL app.company_id = 'aaaaaaaa-0000-0000-0000-000000000017';
SET LOCAL enable_seqscan = off;
SELECT pg_temp.ok(pg_temp.plan($q$SELECT id FROM invitations i WHERE i.company_id = app_company_id()
                                   AND i.accepted_at IS NULL AND i.revoked_at IS NULL$q$)
                  ~ 'invitations_open_company', 'open invitations use invitations_open_company');

ROLLBACK;
