-- Hourly and daily alert emails (alert_email.delivery). /cron/alert-digest mails each such company
-- the tamper events received since its last digest, then sets this. NULL: no digest sent yet.
BEGIN;
ALTER TABLE companies ADD COLUMN alert_digest_sent_at timestamptz;
COMMIT;
