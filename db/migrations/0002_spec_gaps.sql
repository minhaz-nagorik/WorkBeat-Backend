-- WorkBeat backend — schema gaps found while specifying the API (OpenSpec changes 2–14).
-- Doc: docs/core/architecture/data-model.md. Self-check: db/tests/0002_spec_gaps_test.sql.

BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- report-usage, alert-emails, screenshot-access: day and week boundaries in the company's zone.
ALTER TABLE companies ADD COLUMN timezone text NOT NULL DEFAULT 'UTC';
CREATE FUNCTION is_timezone(tz text) RETURNS bool LANGUAGE sql STABLE AS
$$ SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = tz) $$;
ALTER TABLE companies ADD CONSTRAINT companies_timezone_check CHECK (is_timezone(timezone));

-- alert-emails: a new company is alerted about every event type until an admin narrows it.
ALTER TABLE companies ALTER COLUMN alert_email SET DEFAULT
  '{"roles": ["company_admin", "it_admin"], "types": ["process_restart", "hosts_modified", "config_changed", "clock_tampered", "permission_revoked", "offline"], "delivery": "instant"}';

-- activity-ingestion: same Idempotency-Key with a different body answers 409 IDEMPOTENCY_KEY_REUSED.
ALTER TABLE ingest_batches ADD COLUMN body_sha256 text NOT NULL DEFAULT '';
ALTER TABLE ingest_batches ALTER COLUMN body_sha256 DROP DEFAULT;

-- agent-releases: Windows MSIs are not signed (W35).
ALTER TABLE agent_releases ALTER COLUMN signature DROP NOT NULL;

-- productivity-rules: who made the rule, like block rules.
ALTER TABLE productivity_rules ADD COLUMN created_by uuid REFERENCES users ON DELETE SET NULL;

-- monitoring-pauses: one employee never has two live pauses that overlap (D31).
ALTER TABLE monitoring_pauses ADD CONSTRAINT monitoring_pauses_no_overlap
  EXCLUDE USING gist (employee_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (cancelled_at IS NULL);

-- employee-directory: only a device that still holds a seat blocks removing its employee (D44).
-- A deactivated device keeps its employee row reference, which an archived employee still satisfies.
CREATE OR REPLACE FUNCTION employees_archive_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL
     AND EXISTS (SELECT 1 FROM devices WHERE employee_id = NEW.id AND released_at IS NULL AND deactivated_at IS NULL) THEN
    RAISE EXCEPTION 'EMPLOYEE_HAS_DEVICES' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- notice-acknowledgement: a reassigned device records its new employee's acknowledgement (D25).
ALTER TABLE notice_acknowledgements DROP CONSTRAINT notice_acknowledgements_device_id_notice_version_key;
ALTER TABLE notice_acknowledgements ADD CONSTRAINT notice_acknowledgements_device_employee_version_key
  UNIQUE (device_id, employee_id, notice_version);

-- device-enrollment: tell ENROLLMENT_TOKEN_EXPIRED from ENROLLMENT_TOKEN_EXHAUSTED.
DROP FUNCTION auth_enrollment_token(text);
CREATE FUNCTION auth_enrollment_token(p_token_hash text)
RETURNS TABLE (token_id uuid, company_id uuid, employee_id uuid, used bool, expired bool)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, company_id, employee_id, used_at IS NOT NULL, expires_at <= now()
    FROM enrollment_tokens WHERE token_hash = p_token_hash
$$;

-- custom-domains: only {slug}.workbeat.io resolves; x.acme.workbeat.io must not resolve to slug x.
CREATE OR REPLACE FUNCTION company_by_host(p_host citext)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM companies
   WHERE (custom_domain = rtrim(p_host::text, '.') AND custom_domain_status = 'active')
      OR (lower(rtrim(p_host::text, '.')) ~ '^[a-z0-9]+(-[a-z0-9]+)*\.workbeat\.io$'
          AND slug = split_part(lower(p_host::text), '.', 1))
   LIMIT 1
$$;

-- subscription-sync: a Stripe webhook finds its company before any tenant is known (B3).
CREATE FUNCTION company_by_stripe_customer(p_customer_id text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT company_id FROM licenses WHERE stripe_customer_id = p_customer_id
$$;

-- staff-companies: staff see seat counts, never the devices behind them (D41).
CREATE FUNCTION company_seat_counts() RETURNS TABLE (company_id uuid, seats_used int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF app_scope() NOT IN ('staff', 'system') THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001'; END IF;
  RETURN QUERY SELECT c.id, count(d.id)::int FROM companies c
    LEFT JOIN devices d ON d.company_id = c.id AND d.deactivated_at IS NULL AND d.released_at IS NULL
   GROUP BY c.id;
END $$;

-- staff-license-reissue: staff delete a licence's unused tokens without tenant access (D43).
CREATE FUNCTION delete_unused_enrollment_tokens(p_license_id uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  IF app_scope() NOT IN ('staff', 'system') THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001'; END IF;
  DELETE FROM enrollment_tokens WHERE license_id = p_license_id AND used_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- data-retention: the API role does not own the tables, so partition upkeep runs as the owner,
-- and only from a /cron/* route (system scope). Partitions still get no grant (0001).
ALTER FUNCTION ensure_month_partitions(int) SECURITY DEFINER SET search_path = public;
ALTER FUNCTION drop_old_partitions(int) SECURITY DEFINER SET search_path = public;
CREATE OR REPLACE FUNCTION require_system_scope() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF app_scope() <> 'system' THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'P0001'; END IF;
END $$;
CREATE FUNCTION cron_ensure_month_partitions(months_ahead int DEFAULT 2) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$$ BEGIN PERFORM require_system_scope(); PERFORM ensure_month_partitions(months_ahead); END $$;
CREATE FUNCTION cron_drop_old_partitions(keep_days int DEFAULT 365) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$$ BEGIN PERFORM require_system_scope(); RETURN drop_old_partitions(keep_days); END $$;

REVOKE ALL ON FUNCTION ensure_month_partitions(int), drop_old_partitions(int),
  auth_enrollment_token(text), company_by_stripe_customer(text), company_seat_counts(),
  delete_unused_enrollment_tokens(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_enrollment_token(text), company_by_stripe_customer(text),
  company_seat_counts(), delete_unused_enrollment_tokens(uuid),
  cron_ensure_month_partitions(int), cron_drop_old_partitions(int) TO workbeat_api;

COMMIT;
