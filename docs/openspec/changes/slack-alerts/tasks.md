> **Read first — this task list is not the requirement.**
> Capabilities: `slack-alerts`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show slack-alerts`.

## 1. Schema

- [x] 1.1 `db/migrations/0020_slack_alerts.sql`: `companies.slack_webhook_ciphertext`; self-check in `db/tests/`

## 2. API

- [x] 2.1 `PATCH /v1/company/settings` takes `slack_webhook_url`; `GET` returns `slack_webhook_set`
- [x] 2.2 Instant alerts and the digest post to the webhook after commit
- [x] 2.3 Plain alert text for email and Slack: labels, company time zone, Alerts link
