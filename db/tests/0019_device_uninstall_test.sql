-- Self-check for 0019_device_uninstall.sql. Run after every migration:
--   psql -v ON_ERROR_STOP=1 -f db/tests/0019_device_uninstall_test.sql
-- Runs in one transaction that is rolled back. uninstalled_at exists and needs released_at (B36).

BEGIN;

CREATE FUNCTION pg_temp.ok(cond bool, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF; RAISE NOTICE 'ok  %', what; END $$;

SELECT pg_temp.ok(EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_name = 'devices' AND column_name = 'uninstalled_at'
                             AND data_type = 'timestamp with time zone' AND is_nullable = 'YES'),
                  'devices.uninstalled_at is a nullable timestamptz');

SELECT pg_temp.ok(EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devices_uninstalled_is_released'
                             AND pg_get_constraintdef(oid) ~ 'uninstalled_at IS NULL'
                             AND pg_get_constraintdef(oid) ~ 'released_at IS NOT NULL'),
                  'devices_uninstalled_is_released needs released_at for uninstalled_at');

ROLLBACK;
