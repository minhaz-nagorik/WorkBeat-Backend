-- WorkBeat backend — policy pushed to connected agents (push-policy-events, B32).
-- After a committed change to a device's policy, the API's one LISTEN connection per instance
-- hears which company, employee or device it was and pushes the policy down their open streams.
-- NOTIFY is sent only on commit, and identical payloads in one transaction fold into one, so a
-- 200-rule import is one notification and a rolled-back change is none.
-- No `UPDATE OF <column>`: that fires only when the statement names the column, and most versions
-- are raised by BEFORE triggers (companies_policy_bump, settings_policy_bump). WHEN compares rows.
BEGIN;

-- Payload `<kind>:<uuid>`: TG_ARGV[0] is c, e or d; TG_ARGV[1] the column holding the ID.
CREATE FUNCTION notify_policy_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('policy_events', TG_ARGV[0] || ':' || (to_jsonb(NEW) ->> TG_ARGV[1]));
  RETURN NULL;
END $$;

-- company settings, block rules, sensitive domains and the licence tier raise companies.policy_version (B5, B30)
CREATE TRIGGER companies_policy_event AFTER UPDATE ON companies
  FOR EACH ROW WHEN (NEW.policy_version IS DISTINCT FROM OLD.policy_version)
  EXECUTE FUNCTION notify_policy_event('c', 'id');

-- monitoring switches, screenshot interval and pauses raise the employee's settings version
CREATE TRIGGER settings_policy_event AFTER UPDATE ON employee_monitoring_settings
  FOR EACH ROW WHEN (NEW.policy_version IS DISTINCT FROM OLD.policy_version)
  EXECUTE FUNCTION notify_policy_event('e', 'employee_id');

-- a reassignment, a release or a revoked or replaced key: the device's stream re-checks its access
CREATE TRIGGER devices_policy_event AFTER UPDATE ON devices
  FOR EACH ROW WHEN (NEW.policy_version IS DISTINCT FROM OLD.policy_version
                     OR NEW.released_at IS DISTINCT FROM OLD.released_at
                     OR NEW.key_hash IS DISTINCT FROM OLD.key_hash)
  EXECUTE FUNCTION notify_policy_event('d', 'id');

COMMIT;
