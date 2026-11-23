-- Indexes that lead with company_id, for queries that now name company_id themselves (the RLS
-- predicate, with its OR, is never an index condition). employees and users had only partial
-- indexes or ones leading with id, so a company's lookup still read every company's entries.
-- Plain CREATE INDEX (not CONCURRENTLY, which cannot run in a transaction): both tables are small.
BEGIN;
CREATE INDEX employees_company ON employees (company_id);
CREATE INDEX users_company ON users (company_id);

-- Nothing reads devices_heartbeat yet (no /cron/offline). It indexes last_heartbeat_at, which every
-- heartbeat changes, so it kept every heartbeat from being a HOT update. Recreate it with that cron.
DROP INDEX devices_heartbeat;
-- Free space on each page so a heartbeat's new row version fits beside the old one (HOT).
-- Applies to pages written from now on.
ALTER TABLE devices SET (fillfactor = 85);
COMMIT;
