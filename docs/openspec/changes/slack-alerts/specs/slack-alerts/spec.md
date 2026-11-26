## Purpose

A company admin sends tamper alerts to a Slack channel by pasting the channel's incoming-webhook URL.

## ADDED Requirements

### Requirement: A company admin sets the Slack webhook
<!-- source: product owner 26 Nov 2026 · B6 -->
`PATCH /v1/company/settings` SHALL take `slack_webhook_url`: a URL starting with `https://hooks.slack.com/services/`, at most 500 characters, or `null` to remove it. Anything else MUST get `422 VALIDATION_FAILED` with `fields` `["slack_webhook_url"]`. The URL MUST be stored encrypted and never returned or logged; `GET` and `PATCH` return `slack_webhook_set` (true or false) instead.

#### Scenario: An admin adds a webhook
- **WHEN** a company admin patches `{ "slack_webhook_url": "https://hooks.slack.com/services/T0/B0/x" }`
- **THEN** the response has `slack_webhook_set` `true` and no URL

#### Scenario: A URL on another host
- **WHEN** a company admin patches `{ "slack_webhook_url": "https://example.com/hook" }`
- **THEN** the response is `422 VALIDATION_FAILED` with `fields` `["slack_webhook_url"]`

#### Scenario: An admin removes the webhook
- **WHEN** a company admin patches `{ "slack_webhook_url": null }`
- **THEN** `slack_webhook_set` is `false` and no more alerts are posted

### Requirement: Alerts are posted to Slack
<!-- source: product owner 26 Nov 2026 -->
When a company has a webhook, every alert email the company would get (instant or digest, same event types) SHALL also be posted to the webhook as one Slack message, after the transaction commits, whether or not any user gets the email. A failed post MUST be logged without the URL and MUST NOT fail the request or the job.

#### Scenario: An instant alert
- **WHEN** a company with instant delivery, `hosts_modified` on and a webhook receives a `hosts_modified` event
- **THEN** one message naming the event and the computer is posted to the webhook

### Requirement: Alert messages read plainly
<!-- source: product owner 26 Nov 2026 · A4 -->
Alert emails and Slack messages SHALL use the same text. An instant alert's title (the email subject) MUST be `WorkBeat alert: Tamper detected`, followed by `Event:`, `Employee:`, `Computer:` and `Time:` lines (`Unknown` when the computer has no employee). A digest's title MUST be `WorkBeat alert: N tamper events in the last hour` (or `day`), followed by one line per event naming the event, computer, employee and time. Events MUST use the admin's plain labels (no enum values), and times MUST be in the company's time zone, which the message names. Every message MUST end with a link to the Alerts page. Host names MUST be escaped in Slack so they cannot form links or mentions.

#### Scenario: An instant alert
- **WHEN** a company in `Asia/Dhaka` gets an instant `process_restart` alert from `mac-1`, Ada Lovelace's computer, at 07:13 UTC
- **THEN** the title is `WorkBeat alert: Tamper detected` and the lines read `Event: WorkBeat was closed`, `Employee: Ada Lovelace`, `Computer: mac-1`, `Time: 26 Nov 2026, 1:13 PM (Asia/Dhaka)`
