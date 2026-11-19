-- Self-check for 0011_screenshot_thumbnails.sql. Runs as workbeat_api in one transaction that is rolled back.
BEGIN;
SET ROLE workbeat_api;

CREATE FUNCTION pg_temp.ok(cond bool, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF; RAISE NOTICE 'ok  %', what; END $$;

SELECT pg_temp.ok((SELECT is_nullable = 'YES' AND data_type = 'integer' FROM information_schema.columns
                    WHERE table_name = 'screenshots' AND column_name = 'thumb_bytes'), 'thumb_bytes is a nullable integer');
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'screenshots'::regclass AND contype = 'c'
                          AND pg_get_constraintdef(oid) LIKE '%thumb_bytes > 0%'), 'thumb_bytes must be positive');

ROLLBACK;
