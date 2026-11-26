## Why

Tamper alerts reach a company only by email. Company admins asked to get them in their own Slack
channel too (product owner, 26 Nov 2026). A channel name alone gives no right to post, so the admin
pastes a Slack incoming-webhook URL made for that channel; no WorkBeat Slack app is needed.

## What Changes

- **`slack_webhook_url` in `PATCH /v1/company/settings`**: a `https://hooks.slack.com/services/…` URL,
  or `null` to stop. Stored encrypted (B6); `GET` returns only `slack_webhook_set`.
- **Alerts post to Slack** with the same types and delivery (instant, hourly, daily) as the alert email.
- **`db/migrations/0020_slack_alerts.sql`**: `companies.slack_webhook_ciphertext`.

## Capabilities

### New Capabilities

- `slack-alerts`: setting the webhook and what is posted to it.
