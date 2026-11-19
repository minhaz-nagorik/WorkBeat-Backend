-- WorkBeat backend — retention is 30, 60 or 90 days (B13, product owner 19 Nov 2026).
-- Was 1–365. Existing values move up to the next choice, capped at 90: 1–30 → 30, 31–60 → 60,
-- 61–365 → 90. Moving up keeps at least what the company chose wherever the choices allow it.
-- Partition upkeep is unchanged here: /cron/cleanup passes 90 to cron_drop_old_partitions.
-- Self-check: db/tests/0009_retention_choices_test.sql.

BEGIN;

UPDATE companies
   SET data_retention_days = CASE WHEN data_retention_days <= 30 THEN 30 WHEN data_retention_days <= 60 THEN 60 ELSE 90 END
 WHERE data_retention_days NOT IN (30, 60, 90);

ALTER TABLE companies DROP CONSTRAINT companies_data_retention_days_check;
ALTER TABLE companies ADD CONSTRAINT companies_data_retention_days_check CHECK (data_retention_days IN (30, 60, 90));

COMMIT;
