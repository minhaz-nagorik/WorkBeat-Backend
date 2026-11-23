-- Self-check for 0015_tenant_indexes.sql. Run after every migration:
--   psql -v ON_ERROR_STOP=1 -f db/tests/0015_tenant_indexes_test.sql
-- Runs as workbeat_api in one transaction that is rolled back. With sequential scans off, a hot
-- query shape under tenant scope must use an index on company_id: a regression guard for queries
-- that lean on RLS alone. The plan shows app_company_id() inlined, so match on the column only.

BEGIN;
SET ROLE workbeat_api;

CREATE FUNCTION pg_temp.ok(cond bool, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF; RAISE NOTICE 'ok  %', what; END $$;

CREATE FUNCTION pg_temp.plan(q text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text; o text := '';
BEGIN FOR r IN EXECUTE 'EXPLAIN ' || q LOOP o := o || r || E'\n'; END LOOP; RETURN o; END $$;

SELECT pg_temp.ok(to_regclass('employees_company') IS NOT NULL, 'employees_company exists');
SELECT pg_temp.ok(to_regclass('users_company') IS NOT NULL, 'users_company exists');
SELECT pg_temp.ok(to_regclass('devices_heartbeat') IS NULL, 'devices_heartbeat is gone');
SELECT pg_temp.ok((SELECT 'fillfactor=85' = ANY (reloptions) FROM pg_class WHERE oid = 'devices'::regclass), 'devices fillfactor is 85');

SET LOCAL app.scope = 'tenant';
SET LOCAL app.company_id = 'aaaaaaaa-0000-0000-0000-000000000015';
SET LOCAL enable_seqscan = off;
SELECT pg_temp.ok(pg_temp.plan('SELECT id FROM employees WHERE company_id = app_company_id() AND archived_at IS NULL')
                  ~ 'Index Cond: \(+company_id = ', 'employee lookup uses a company_id index');
SELECT pg_temp.ok(pg_temp.plan($q$SELECT 1 FROM users WHERE company_id = app_company_id() AND role = 'company_admin'$q$)
                  ~ 'Index Cond: \(+company_id = ', 'user lookup uses a company_id index');
SELECT pg_temp.ok(pg_temp.plan($q$SELECT category FROM productivity_rules r WHERE r.company_id = app_company_id()
                                   AND r.match_type = 'app' AND lower(r.pattern) = lower('Slack')$q$)
                  ~ 'Index Cond: \(+company_id = ', 'category lookup uses the rules index');
SELECT pg_temp.ok(pg_temp.plan($q$SELECT id FROM devices WHERE company_id = app_company_id() AND hardware_id = 'X' AND released_at IS NULL$q$)
                  ~ 'Index Cond: \(+company_id = ', 'enroll lookup uses devices_hardware');

ROLLBACK;
