-- WorkBeat private sites (admin round 9, A19): one staff-kept list, never recorded at every company.
-- No tenant data, so no RLS (like agent_releases); companies read it, only staff routes write it.
BEGIN;

CREATE TABLE platform_sensitive_domains (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern    text NOT NULL CHECK (length(pattern) BETWEEN 1 AND 253),
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_sensitive_domains_unique ON platform_sensitive_domains (lower(pattern));

-- One change is in every company's policy: bump them all once per statement, which pushes it (B32).
CREATE FUNCTION platform_sensitive_policy_bump() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE companies SET policy_version = nextval('policy_version_seq');
  RETURN NULL;
END $$;
CREATE TRIGGER platform_sensitive_domains_policy AFTER INSERT OR UPDATE OR DELETE ON platform_sensitive_domains
  FOR EACH STATEMENT EXECUTE FUNCTION platform_sensitive_policy_bump();

GRANT SELECT, INSERT, UPDATE, DELETE ON platform_sensitive_domains TO workbeat_api;

COMMIT;
