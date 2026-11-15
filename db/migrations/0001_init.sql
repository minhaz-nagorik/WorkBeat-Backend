-- WorkBeat backend — initial schema (Plan v3.2).
-- Doc: docs/core/architecture/data-model.md. Target: Supabase PostgreSQL 15+.
--
-- Conventions
--   * Every tenant table has company_id and row-level security (Plan §6.1). The API connects as
--     workbeat_api and runs each request in a transaction that sets:
--       SET LOCAL app.scope = 'tenant' | 'staff' | 'system';
--       SET LOCAL app.company_id = '<uuid>';           -- tenant scope only
--     tenant  sees only its company. staff sees companies, licenses, users, invitations and
--     agent_releases, never employee or activity data (D41). system (cron jobs) sees everything.
--   * Agent and Downloader credentials are looked up before any tenant is known, through the
--     SECURITY DEFINER auth_* functions at the end, which return only what the guard needs.
--   * Enums are text + CHECK. Times are timestamptz. Secrets are stored as SHA-256 hex (*_hash);
--     the license key and uninstall token are also stored encrypted by the API (*_ciphertext).
--   * Seats are never stored: a device holds a seat while deactivated_at and released_at are NULL
--     (D43). A trigger enforces the seat limit.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workbeat_api') THEN
    CREATE ROLE workbeat_api NOLOGIN;   -- the API's login role is granted membership by ops
  END IF;
END $$;

-- ---------------------------------------------------------------- helpers

CREATE FUNCTION app_company_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.company_id', true), '')::uuid $$;

CREATE FUNCTION app_scope() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('app.scope', true), ''), 'none') $$;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- One global sequence so a device's policy_version = greatest(company, employee, device) only
-- ever grows (replaces Plan §6.2 policy_versions).
CREATE SEQUENCE policy_version_seq;

-- Screenshot tier → interval in seconds (PRD "Pricing"). Used for a new employee's default.
CREATE FUNCTION tier_interval(tier text) RETURNS int LANGUAGE sql IMMUTABLE AS
$$ SELECT CASE tier WHEN 'light' THEN 3600 WHEN 'standard' THEN 1800 WHEN 'intensive' THEN 600 ELSE 0 END $$;

-- ---------------------------------------------------------------- 1. company, licence, billing

CREATE TABLE companies (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        text NOT NULL,
  slug                        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 32),
  status                      text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial', 'active', 'suspended', 'expired')),
  suspended_reason            text CHECK (suspended_reason IN ('payment_failed', 'staff')),
  suspended_at                timestamptz,
  expired_blocking_grace_days int  NOT NULL DEFAULT 30 CHECK (expired_blocking_grace_days >= 0),
  data_retention_days         int  NOT NULL DEFAULT 90 CHECK (data_retention_days BETWEEN 1 AND 365),
  idle_threshold_seconds      int  NOT NULL DEFAULT 300 CHECK (idle_threshold_seconds BETWEEN 60 AND 3600),
  min_agent_version           text,
  uninstall_token_hash        text NOT NULL,
  uninstall_token_ciphertext  bytea NOT NULL,
  notice_text                 text NOT NULL,
  notice_version              int  NOT NULL DEFAULT 1 CHECK (notice_version >= 1),
  policy_version              bigint NOT NULL DEFAULT nextval('policy_version_seq'),
  custom_domain               citext UNIQUE,
  custom_domain_status        text CHECK (custom_domain_status IN ('pending', 'active', 'failed')),
  custom_domain_token         text,
  custom_domain_checked_at    timestamptz,
  custom_domain_verified_at   timestamptz,
  alert_email                 jsonb NOT NULL DEFAULT '{"roles": ["company_admin", "it_admin"], "types": [], "delivery": "instant"}',
  setup_completed_steps       text[] NOT NULL DEFAULT '{}',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'suspended') = (suspended_reason IS NOT NULL)),
  CHECK ((custom_domain IS NULL) = (custom_domain_status IS NULL))
);

CREATE TABLE licenses (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL UNIQUE REFERENCES companies ON DELETE CASCADE,
  key_hash               text NOT NULL UNIQUE,
  key_ciphertext         bytea NOT NULL,
  key_last4              text NOT NULL CHECK (length(key_last4) = 4),
  key_reset_at           timestamptz,
  plan                   text NOT NULL CHECK (plan IN ('starter', 'growth', 'enterprise')),
  seat_limit             int CHECK (seat_limit >= 1),      -- NULL = unlimited (Enterprise)
  screenshot_tier        text NOT NULL DEFAULT 'off' CHECK (screenshot_tier IN ('off', 'light', 'standard', 'intensive')),
  trial_ends_at          timestamptz,
  current_period_end     timestamptz,
  expired_at             timestamptz,                       -- blocking_ends_at = expired_at + grace days (D36)
  stripe_customer_id     text UNIQUE,
  stripe_subscription_id text UNIQUE,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (plan = 'enterprise' OR seat_limit IS NOT NULL)
);

CREATE TABLE stripe_events (        -- global, webhook idempotency
  id           text PRIMARY KEY,     -- evt_...
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

-- ---------------------------------------------------------------- 2. identity and access

CREATE TABLE users (                -- mirror of auth.users + app_metadata, written only by the API (D41)
  id          uuid PRIMARY KEY,      -- = auth.users.id
  email       citext NOT NULL UNIQUE,
  name        text NOT NULL,
  role        text NOT NULL CHECK (role IN ('super_admin', 'company_admin', 'manager', 'it_admin')),
  company_id  uuid REFERENCES companies ON DELETE CASCADE,
  disabled_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'super_admin') = (company_id IS NULL)),
  UNIQUE (id, company_id)
);

CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid REFERENCES companies ON DELETE CASCADE,     -- NULL = staff invites staff
  email       citext NOT NULL,
  role        text NOT NULL CHECK (role IN ('super_admin', 'company_admin', 'manager', 'it_admin')),
  token_hash  text NOT NULL UNIQUE,
  invited_by  uuid NOT NULL REFERENCES users,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'super_admin') = (company_id IS NULL))
);
CREATE UNIQUE INDEX invitations_one_open ON invitations (coalesce(company_id, '00000000-0000-0000-0000-000000000000'), email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------- 3. people

CREATE TABLE employees (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies ON DELETE CASCADE,
  name            text NOT NULL,
  email           citext,
  department      text,
  manager_user_id uuid,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  FOREIGN KEY (manager_user_id, company_id) REFERENCES users (id, company_id) ON DELETE SET NULL (manager_user_id)
);
CREATE UNIQUE INDEX employees_email ON employees (company_id, email) WHERE archived_at IS NULL AND email IS NOT NULL;
CREATE INDEX employees_manager ON employees (company_id, manager_user_id) WHERE manager_user_id IS NOT NULL;

CREATE TABLE employee_monitoring_settings (     -- 1:1, created by trigger with the employee (D37)
  employee_id                 uuid PRIMARY KEY,
  company_id                  uuid NOT NULL,
  activity                    bool NOT NULL DEFAULT true,
  app_usage                   bool NOT NULL DEFAULT true,
  window_titles               bool NOT NULL DEFAULT true,
  website_visits              bool NOT NULL DEFAULT true,
  -- The agent accepts only these values. The API also requires 0 or no more often than the tier.
  screenshot_interval_seconds int  NOT NULL DEFAULT 0 CHECK (screenshot_interval_seconds IN (0, 600, 1800, 3600)),
  policy_version              bigint NOT NULL DEFAULT nextval('policy_version_seq'),
  updated_by                  uuid REFERENCES users ON DELETE SET NULL,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (employee_id, company_id) REFERENCES employees (id, company_id) ON DELETE CASCADE
);

CREATE TABLE monitoring_pauses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- the agent's pause_id (D31)
  company_id   uuid NOT NULL,
  employee_id  uuid NOT NULL,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  reason       text NOT NULL CHECK (reason IN ('annual_leave', 'sick_leave', 'personal', 'offsite_training', 'other')),
  note         text,
  created_by   uuid NOT NULL REFERENCES users,
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  FOREIGN KEY (employee_id, company_id) REFERENCES employees (id, company_id) ON DELETE CASCADE
);
CREATE INDEX monitoring_pauses_employee ON monitoring_pauses (employee_id, ends_at) WHERE cancelled_at IS NULL;

-- ---------------------------------------------------------------- 4. policy

CREATE TABLE block_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN ('domain', 'url')),   -- no regex (D39)
  pattern    text NOT NULL CHECK (length(pattern) BETWEEN 1 AND 2048),
  reason     text,
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX block_rules_unique ON block_rules (company_id, type, lower(pattern));

CREATE TABLE sensitive_domains (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies ON DELETE CASCADE,
  pattern    text NOT NULL CHECK (length(pattern) BETWEEN 1 AND 253),
  is_default bool NOT NULL DEFAULT false,      -- seeded at signup from packages/shared (D4)
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sensitive_domains_unique ON sensitive_domains (company_id, lower(pattern));

CREATE TABLE productivity_rules (   -- category resolved at report time, never stored on activity (PRD)
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies ON DELETE CASCADE,
  match_type text NOT NULL CHECK (match_type IN ('app', 'domain')),
  pattern    text NOT NULL,
  category   text NOT NULL CHECK (category IN ('productive', 'neutral', 'unproductive')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX productivity_rules_unique ON productivity_rules (company_id, match_type, lower(pattern));

-- ---------------------------------------------------------------- 5. devices and deployment

CREATE TABLE enrollment_tokens (    -- internal, single-use, issued only by /license/validate (D26, D43)
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  license_id  uuid NOT NULL REFERENCES licenses ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  employee_id uuid NOT NULL,       -- picked in the Downloader; required (D44)
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  FOREIGN KEY (employee_id, company_id) REFERENCES employees (id, company_id)
);
CREATE INDEX enrollment_tokens_unused ON enrollment_tokens (license_id) WHERE used_at IS NULL;

CREATE TABLE devices (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid NOT NULL REFERENCES companies ON DELETE CASCADE,
  employee_id             uuid NOT NULL,           -- every device has an employee; no unassigned queue (D44)
  enrollment_token_id     uuid,
  key_hash                text UNIQUE,             -- NULL after deactivate; replaced on re-enroll (D2)
  key_issued_at           timestamptz,
  hostname                text NOT NULL,
  os                      text NOT NULL CHECK (os IN ('macos', 'windows')),
  os_version              text NOT NULL,
  arch                    text NOT NULL CHECK (arch IN ('x64', 'arm64')),
  model                   text,
  serial_number           text,
  hardware_id             text NOT NULL,           -- device ID the agent produces; format open (Q10), must survive a reinstall (D2)
  agent_version           text NOT NULL,
  enrolled_via            text NOT NULL DEFAULT 'manual' CHECK (enrolled_via = 'manual'),   -- D40
  enrolled_at             timestamptz NOT NULL DEFAULT now(),
  policy_version          bigint NOT NULL DEFAULT nextval('policy_version_seq'),  -- bumped on reassignment
  last_heartbeat_at       timestamptz,
  offline_since           timestamptz,
  reported_policy_version bigint,
  helper_status           jsonb,
  browser_access          jsonb,
  permissions             jsonb,
  health                  jsonb,
  active_pause_id         uuid,
  notice_ack_version      int,
  deactivated_at          timestamptz,             -- seat freed, key cleared → 401 (D6)
  released_at             timestamptz,             -- seat freed, key kept → 401 DEVICE_RELEASED (D38)
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, company_id),
  FOREIGN KEY (employee_id, company_id) REFERENCES employees (id, company_id),
  FOREIGN KEY (enrollment_token_id, company_id) REFERENCES enrollment_tokens (id, company_id) ON DELETE SET NULL (enrollment_token_id),
  CHECK (deactivated_at IS NULL OR key_hash IS NULL)
);
-- Re-enrolling the same hardware reuses the row (D2); a released device's next enrollment is new (D38).
CREATE UNIQUE INDEX devices_hardware ON devices (company_id, hardware_id) WHERE released_at IS NULL;
CREATE INDEX devices_employee ON devices (company_id, employee_id);
CREATE INDEX devices_seat ON devices (company_id) WHERE deactivated_at IS NULL AND released_at IS NULL;
CREATE INDEX devices_heartbeat ON devices (last_heartbeat_at) WHERE released_at IS NULL AND deactivated_at IS NULL;

CREATE TABLE notice_acknowledgements (   -- append-only evidence (D25)
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL,
  device_id       uuid NOT NULL,
  employee_id     uuid NOT NULL,
  notice_version  int NOT NULL,
  acknowledged_at timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, notice_version),
  FOREIGN KEY (device_id, company_id) REFERENCES devices (id, company_id) ON DELETE CASCADE
);

CREATE TABLE agent_releases (       -- global, staff-managed
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product       text NOT NULL CHECK (product IN ('agent', 'downloader')),
  platform      text NOT NULL CHECK (platform IN ('macos', 'windows')),
  arch          text NOT NULL CHECK (arch IN ('x64', 'arm64', 'universal')),
  version       text NOT NULL CHECK (version ~ '^\d+\.\d+\.\d+$'),
  min_supported text NOT NULL CHECK (min_supported ~ '^\d+\.\d+\.\d+$'),  -- newest release's value = global minimum
  storage_path  text NOT NULL,
  sha256        text NOT NULL,
  signature     text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  release_notes text,
  published_by  uuid NOT NULL REFERENCES users,
  released_at   timestamptz NOT NULL DEFAULT now(),
  withdrawn_at  timestamptz,
  UNIQUE (product, platform, arch, version)
);

-- ---------------------------------------------------------------- 6. ingested data

CREATE TABLE ingest_batches (       -- idempotency for POST /agents/activity (D13); kept 14 days
  device_id   uuid NOT NULL,
  batch_id    uuid NOT NULL,
  company_id  uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  counts      jsonb NOT NULL,
  PRIMARY KEY (device_id, batch_id),
  FOREIGN KEY (device_id, company_id) REFERENCES devices (id, company_id) ON DELETE CASCADE
);
CREATE INDEX ingest_batches_received ON ingest_batches (received_at);

-- The four high-volume tables are range-partitioned by month (Plan §6.3). employee_id is the
-- device's employee at ingest, so reports and manager scoping never join through devices.
-- shortcut: no FKs and no surrogate key on these tables, to keep ingest cheap; integrity comes from
-- the device guard and ingest_batches. Add FKs only if a load test shows the cost is acceptable.
CREATE TABLE app_sessions (
  company_id       uuid NOT NULL,
  device_id        uuid NOT NULL,
  employee_id      uuid NOT NULL,
  batch_id         uuid NOT NULL,
  os_user          text NOT NULL,   -- wire field session_user (a reserved word here)
  bundle_id        text NOT NULL,
  app_name         text NOT NULL,
  process_name     text NOT NULL,
  window_title     text NOT NULL DEFAULT '',   -- '' when withheld (D20), off (D37) or sensitive (D4)
  started_at       timestamptz NOT NULL,
  ended_at         timestamptz NOT NULL,
  duration_seconds int NOT NULL CHECK (duration_seconds >= 0),
  clock_flag       bool NOT NULL DEFAULT false
) PARTITION BY RANGE (started_at);
CREATE INDEX app_sessions_employee ON app_sessions (company_id, employee_id, started_at);
CREATE INDEX app_sessions_device ON app_sessions (device_id, started_at);

CREATE TABLE url_visits (
  company_id       uuid NOT NULL,
  device_id        uuid NOT NULL,
  employee_id      uuid NOT NULL,
  batch_id         uuid NOT NULL,
  os_user          text NOT NULL,   -- wire field session_user (a reserved word here)
  browser          text NOT NULL,
  url              text NOT NULL,
  domain           text NOT NULL,
  visited_at       timestamptz NOT NULL,
  duration_seconds int NOT NULL CHECK (duration_seconds >= 0)
) PARTITION BY RANGE (visited_at);
CREATE INDEX url_visits_employee ON url_visits (company_id, employee_id, visited_at);
CREATE INDEX url_visits_domain ON url_visits (company_id, domain, visited_at);

CREATE TABLE activity_buckets (
  company_id     uuid NOT NULL,
  device_id      uuid NOT NULL,
  employee_id    uuid NOT NULL,
  bucket_start   timestamptz NOT NULL,
  active_samples int NOT NULL CHECK (active_samples >= 0),
  total_samples  int NOT NULL CHECK (total_samples >= 0),
  CHECK (active_samples <= total_samples),
  PRIMARY KEY (device_id, bucket_start)
) PARTITION BY RANGE (bucket_start);
CREATE INDEX activity_buckets_employee ON activity_buckets (company_id, employee_id, bucket_start);

CREATE TABLE idle_intervals (
  company_id   uuid NOT NULL,
  device_id    uuid NOT NULL,
  employee_id  uuid NOT NULL,
  batch_id     uuid NOT NULL,
  os_user      text NOT NULL,
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz NOT NULL,
  CHECK (ended_at >= started_at)
) PARTITION BY RANGE (started_at);
CREATE INDEX idle_intervals_employee ON idle_intervals (company_id, employee_id, started_at);

CREATE TABLE screenshots (
  id           uuid PRIMARY KEY,      -- the agent's UUIDv7, its Idempotency-Key
  company_id   uuid NOT NULL,
  device_id    uuid NOT NULL,
  employee_id  uuid NOT NULL,
  captured_at  timestamptz NOT NULL,
  storage_path text NOT NULL UNIQUE,  -- {company_id}/{device_id}/{id}.jpg
  bytes        int NOT NULL CHECK (bytes > 0),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploaded')),
  uploaded_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (device_id, company_id) REFERENCES devices (id, company_id) ON DELETE CASCADE
);
CREATE INDEX screenshots_employee ON screenshots (company_id, employee_id, captured_at);

CREATE TABLE tamper_events (        -- also the alerts feed
  id           uuid PRIMARY KEY,      -- the agent's UUIDv7; server-made for offline
  company_id   uuid NOT NULL,
  device_id    uuid NOT NULL,
  hostname     text NOT NULL,         -- snapshot, survives release
  event_type   text NOT NULL CHECK (event_type IN ('process_restart', 'hosts_modified', 'config_changed', 'clock_tampered', 'permission_revoked', 'offline')),
  detail       jsonb NOT NULL DEFAULT '{}',
  repeat_count int NOT NULL DEFAULT 1 CHECK (repeat_count >= 1),
  occurred_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,           -- offline: set when the heartbeat returns
  resolved_by  uuid REFERENCES users ON DELETE SET NULL,
  emailed_at   timestamptz,
  FOREIGN KEY (device_id, company_id) REFERENCES devices (id, company_id) ON DELETE CASCADE
);
CREATE INDEX tamper_events_feed ON tamper_events (company_id, occurred_at DESC);
CREATE INDEX tamper_events_open ON tamper_events (device_id) WHERE resolved_at IS NULL;
CREATE INDEX tamper_events_unsent ON tamper_events (company_id) WHERE emailed_at IS NULL;

-- ---------------------------------------------------------------- triggers

CREATE TRIGGER companies_updated BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER licenses_updated BEFORE UPDATE ON licenses FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER employees_updated BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER devices_updated BEFORE UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Company-wide policy fields bump the company's policy_version.
CREATE FUNCTION companies_policy_bump() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.notice_text, NEW.notice_version, NEW.idle_threshold_seconds, NEW.min_agent_version, NEW.uninstall_token_hash)
     IS DISTINCT FROM (OLD.notice_text, OLD.notice_version, OLD.idle_threshold_seconds, OLD.min_agent_version, OLD.uninstall_token_hash) THEN
    NEW.policy_version := nextval('policy_version_seq');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER companies_policy BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION companies_policy_bump();

-- Block rules and sensitive domains are in every device's policy.
CREATE FUNCTION rules_policy_bump() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE companies SET policy_version = nextval('policy_version_seq')
   WHERE id = coalesce(NEW.company_id, OLD.company_id);
  RETURN NULL;
END $$;
CREATE TRIGGER block_rules_policy AFTER INSERT OR UPDATE OR DELETE ON block_rules FOR EACH ROW EXECUTE FUNCTION rules_policy_bump();
CREATE TRIGGER sensitive_domains_policy AFTER INSERT OR UPDATE OR DELETE ON sensitive_domains FOR EACH ROW EXECUTE FUNCTION rules_policy_bump();

-- Every write to an employee's settings bumps their policy_version.
CREATE FUNCTION settings_policy_bump() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.policy_version := nextval('policy_version_seq');
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER settings_policy BEFORE UPDATE ON employee_monitoring_settings FOR EACH ROW EXECUTE FUNCTION settings_policy_bump();

-- A pause added, extended or cancelled reaches the employee's policy (D31).
CREATE FUNCTION pauses_policy_bump() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE employee_monitoring_settings SET updated_at = now()
   WHERE employee_id = coalesce(NEW.employee_id, OLD.employee_id);
  RETURN NULL;
END $$;
CREATE TRIGGER pauses_policy AFTER INSERT OR UPDATE OR DELETE ON monitoring_pauses FOR EACH ROW EXECUTE FUNCTION pauses_policy_bump();

-- A new employee gets settings: all switches on, screenshots at the company's tier.
CREATE FUNCTION employees_create_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO employee_monitoring_settings (employee_id, company_id, screenshot_interval_seconds)
  SELECT NEW.id, NEW.company_id, coalesce((SELECT tier_interval(screenshot_tier) FROM licenses WHERE company_id = NEW.company_id), 0);
  RETURN NULL;
END $$;
CREATE TRIGGER employees_settings AFTER INSERT ON employees FOR EACH ROW EXECUTE FUNCTION employees_create_settings();

-- An employee who still has an unreleased device cannot be removed (D44): reassign or release first.
CREATE FUNCTION employees_archive_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL
     AND EXISTS (SELECT 1 FROM devices WHERE employee_id = NEW.id AND released_at IS NULL) THEN
    RAISE EXCEPTION 'EMPLOYEE_HAS_DEVICES' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employees_archive BEFORE UPDATE OF archived_at ON employees FOR EACH ROW EXECUTE FUNCTION employees_archive_check();

-- Reassigning a device changes whose settings it gets, so its version must still grow.
CREATE FUNCTION devices_policy_bump() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.employee_id IS DISTINCT FROM OLD.employee_id THEN
    NEW.policy_version := nextval('policy_version_seq');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER devices_policy BEFORE UPDATE OF employee_id ON devices FOR EACH ROW EXECUTE FUNCTION devices_policy_bump();

-- Seat limit (D43): a device that starts holding a seat locks the licence row and counts.
CREATE FUNCTION devices_seat_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lim int; used int;
BEGIN
  IF NEW.deactivated_at IS NOT NULL OR NEW.released_at IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.deactivated_at IS NULL AND OLD.released_at IS NULL THEN RETURN NEW; END IF;
  SELECT seat_limit INTO lim FROM licenses WHERE company_id = NEW.company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LICENSE_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF lim IS NULL THEN RETURN NEW; END IF;
  SELECT count(*) INTO used FROM devices
   WHERE company_id = NEW.company_id AND deactivated_at IS NULL AND released_at IS NULL AND id <> NEW.id;
  IF used >= lim THEN RAISE EXCEPTION 'SEAT_LIMIT_EXCEEDED' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER devices_seat BEFORE INSERT OR UPDATE OF deactivated_at, released_at ON devices
  FOR EACH ROW EXECUTE FUNCTION devices_seat_check();

-- ---------------------------------------------------------------- partitions

-- Creates monthly partitions from last month to `months_ahead` months ahead. Idempotent; run by
-- /cron/cleanup daily. The API refuses records outside [now - 8 days, now + 1 day], so no
-- default partition is needed.
CREATE FUNCTION ensure_month_partitions(months_ahead int DEFAULT 2) RETURNS void LANGUAGE plpgsql AS $$
DECLARE t text; m date; part text;
BEGIN
  FOREACH t IN ARRAY ARRAY['app_sessions', 'url_visits', 'activity_buckets', 'idle_intervals'] LOOP
    FOR i IN -1..months_ahead LOOP
      m := (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => i))::date;
      part := format('%s_%s', t, to_char(m, 'YYYYMM'));
      IF to_regclass(part) IS NULL THEN
        EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                       part, t, m::timestamptz, (m + interval '1 month')::timestamptz);
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- Drops monthly partitions that end before now - keep_days (the 365-day retention maximum).
CREATE FUNCTION drop_old_partitions(keep_days int DEFAULT 365) RETURNS int LANGUAGE plpgsql AS $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname IN ('app_sessions', 'url_visits', 'activity_buckets', 'idle_intervals')
  LOOP
    IF substring(r.bound FROM 'TO \(''([^'']+)''\)')::timestamptz < now() - make_interval(days => keep_days) THEN
      EXECUTE format('DROP TABLE %I', r.relname);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- ---------------------------------------------------------------- row-level security

DO $$
DECLARE t text;
BEGIN
  -- Tenant data: own company only; system jobs see all. Staff see none of it (D41).
  FOREACH t IN ARRAY ARRAY['employees', 'employee_monitoring_settings', 'monitoring_pauses', 'block_rules',
      'sensitive_domains', 'productivity_rules', 'enrollment_tokens', 'devices', 'notice_acknowledgements',
      'ingest_batches', 'app_sessions', 'url_visits', 'activity_buckets', 'idle_intervals', 'screenshots',
      'tamper_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant ON %I USING (company_id = app_company_id() OR app_scope() = 'system')
                     WITH CHECK (company_id = app_company_id() OR app_scope() = 'system')$p$, t);
  END LOOP;
  -- Tables staff may also read and write.
  FOREACH t IN ARRAY ARRAY['licenses', 'users', 'invitations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant ON %I USING (company_id = app_company_id() OR app_scope() IN ('staff', 'system'))
                     WITH CHECK (company_id = app_company_id() OR app_scope() IN ('staff', 'system'))$p$, t);
  END LOOP;
END $$;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON companies USING (id = app_company_id() OR app_scope() IN ('staff', 'system'))
  WITH CHECK (id = app_company_id() OR app_scope() IN ('staff', 'system'));

-- agent_releases and stripe_events hold no tenant data: no RLS, API-only grants below.

GRANT USAGE ON SCHEMA public TO workbeat_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO workbeat_api;
GRANT USAGE ON SEQUENCE policy_version_seq TO workbeat_api;
DO $$ BEGIN
  -- Supabase's PostgREST roles get nothing: all access goes through the API.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
  END IF;
END $$;

-- After the grants on purpose: partitions are never granted to workbeat_api, so the API reaches
-- them only through the parent table and its RLS policy.
SELECT ensure_month_partitions();

-- ---------------------------------------------------------------- credential lookups
-- Run before a tenant is known; each returns only what its guard needs.

CREATE FUNCTION auth_device(p_key_hash text)
RETURNS TABLE (device_id uuid, company_id uuid, employee_id uuid, released bool)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, company_id, employee_id, released_at IS NOT NULL FROM devices WHERE key_hash = p_key_hash
$$;

CREATE FUNCTION auth_license(p_key_hash text)
RETURNS TABLE (license_id uuid, company_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, company_id FROM licenses WHERE key_hash = p_key_hash
$$;

CREATE FUNCTION auth_enrollment_token(p_token_hash text)
RETURNS TABLE (token_id uuid, company_id uuid, employee_id uuid, usable bool)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, company_id, employee_id, used_at IS NULL AND expires_at > now() FROM enrollment_tokens WHERE token_hash = p_token_hash
$$;

CREATE FUNCTION auth_invitation(p_token_hash text)
RETURNS TABLE (invitation_id uuid, company_id uuid, email citext, role text, usable bool)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id, company_id, email, role, accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
    FROM invitations WHERE token_hash = p_token_hash
$$;

CREATE FUNCTION company_by_host(p_host citext)   -- {slug}.workbeat.io or an active custom domain
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM companies
   WHERE (custom_domain = p_host AND custom_domain_status = 'active')
      OR slug = split_part(p_host::text, '.', 1) AND p_host::text LIKE '%.workbeat.io'
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION auth_device(text), auth_license(text), auth_enrollment_token(text),
  auth_invitation(text), company_by_host(citext) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_device(text), auth_license(text), auth_enrollment_token(text),
  auth_invitation(text), company_by_host(citext) TO workbeat_api;

COMMIT;
