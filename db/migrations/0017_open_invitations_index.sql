-- The team page lists a company's open invitations by company_id. invitations_one_open is on
-- coalesce(company_id, …), which a plain company_id condition cannot use, so it scanned every
-- company's invitations, and accepted ones are kept for ever. Only open ones are indexed.
BEGIN;
CREATE INDEX invitations_open_company ON invitations (company_id) WHERE accepted_at IS NULL AND revoked_at IS NULL;
COMMIT;
