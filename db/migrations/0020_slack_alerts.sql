-- Slack alerts (slack-alerts). The company's Slack incoming-webhook URL, encrypted with
-- SECRETS_ENCRYPTION_KEY (B6). NULL: alerts go by email only.
BEGIN;
ALTER TABLE companies ADD COLUMN slack_webhook_ciphertext bytea;
COMMIT;
