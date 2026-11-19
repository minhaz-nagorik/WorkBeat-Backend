-- Self-check for 0012_device_last_input.sql. Runs as workbeat_api in one transaction that is rolled back.
BEGIN;
SET ROLE workbeat_api;

CREATE FUNCTION pg_temp.ok(cond bool, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF; RAISE NOTICE 'ok  %', what; END $$;

SELECT pg_temp.ok((SELECT is_nullable = 'YES' AND data_type = 'timestamp with time zone' FROM information_schema.columns
                    WHERE table_name = 'devices' AND column_name = 'last_input_at'), 'last_input_at is a nullable timestamptz');

ROLLBACK;
