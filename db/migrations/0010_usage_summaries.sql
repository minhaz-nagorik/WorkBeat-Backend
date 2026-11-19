-- WorkBeat backend — per-day usage summaries (B28, summarize-usage).
-- Built by /cron/usage-summary for finished company days; reports read them for days in
-- usage_days and raw rows for the rest. Days and hours are in the company timezone.
-- shortcut: no FKs and no partitions, like the raw activity tables; rows are deleted per company
-- and day by the job. Self-check: db/tests/0010_usage_summaries_test.sql.

BEGIN;

CREATE TABLE usage_days (
  company_id uuid NOT NULL,
  day        date NOT NULL,
  built_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, day)
);

CREATE TABLE usage_hours (
  company_id      uuid NOT NULL,
  employee_id     uuid NOT NULL,
  day             date NOT NULL,
  hour            smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  tracked_seconds bigint NOT NULL DEFAULT 0,
  sessions        int NOT NULL DEFAULT 0,
  buckets         int NOT NULL DEFAULT 0,
  active_samples  bigint NOT NULL DEFAULT 0,
  total_samples   bigint NOT NULL DEFAULT 0,
  idle_seconds    numeric NOT NULL DEFAULT 0, -- exact, so a range's total rounds once, as from raw rows
  first_at        timestamptz,                -- earliest start of a session that started in this hour
  last_at         timestamptz,                -- latest end of a session that started in this hour
  PRIMARY KEY (company_id, employee_id, day, hour)
);

CREATE TABLE usage_apps (
  company_id  uuid NOT NULL,
  employee_id uuid NOT NULL,
  day         date NOT NULL,
  app_name    text NOT NULL,
  seconds     bigint NOT NULL,
  PRIMARY KEY (company_id, employee_id, day, app_name)
);

CREATE TABLE usage_domains (
  company_id  uuid NOT NULL,
  employee_id uuid NOT NULL,
  day         date NOT NULL,
  domain      text NOT NULL,
  seconds     bigint NOT NULL,
  PRIMARY KEY (company_id, employee_id, day, domain)
);

-- For the job's per-company deletes and rebuilds.
CREATE INDEX usage_hours_day ON usage_hours (company_id, day);
CREATE INDEX usage_apps_day ON usage_apps (company_id, day);
CREATE INDEX usage_domains_day ON usage_domains (company_id, day);

-- Same policy as the activity tables: tenant or system, never staff (D41).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['usage_days', 'usage_hours', 'usage_apps', 'usage_domains'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant ON %I USING (company_id = app_company_id() OR app_scope() = 'system')
                     WITH CHECK (company_id = app_company_id() OR app_scope() = 'system')$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO workbeat_api', t);
  END LOOP;
END $$;

COMMIT;
