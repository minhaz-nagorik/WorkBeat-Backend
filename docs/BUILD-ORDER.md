# Build order

The backend is specified as fourteen OpenSpec changes in `docs/openspec/changes/`. Build them in
this order; each depends only on changes above it. Capabilities are listed so no two changes
specify the same behaviour.

| # | Change | Capabilities | Depends on |
|---|---|---|---|
| 1 | `establish-api-foundation` | `api-envelope`, `request-scope`, `api-logging`, `rate-limiting`, `schema-migrations` | — |
| 2 | `authenticate-users` | `user-authentication`, `role-access`, `team-invitations`, `staff-accounts` | 1 |
| 3 | `provision-companies` | `company-signup`, `subscription-sync`, `company-status`, `license-key` | 1, 2 |
| 4 | `configure-company` | `company-settings`, `custom-domains` | 3 |
| 5 | `manage-employees` | `employee-directory`, `manager-teams`, `monitoring-settings`, `monitoring-pauses` | 2, 3 |
| 6 | `enroll-devices` | `license-validation`, `device-enrollment`, `device-authentication`, `device-lifecycle` | 3, 5 |
| 7 | `serve-agent-policy` | `agent-policy`, `block-rules`, `sensitive-domains`, `productivity-rules`, `collection-notice` | 5, 6 |
| 8 | `receive-device-health` | `heartbeat`, `notice-acknowledgement`, `device-status` | 6, 7 |
| 9 | `ingest-activity` | `activity-ingestion`, `screenshot-upload`, `screenshot-access` | 6 |
| 10 | `process-tamper-alerts` | `tamper-ingestion`, `alerts-feed` | 6, 8 |
| 11 | `report-usage` | `usage-reports`, `calendar-and-timesheets`, `data-export`, `dashboard-summary` | 7, 9 |
| 12 | `distribute-agents` | `agent-releases`, `installer-downloads`, `agent-updates` | 6, 7 |
| 13 | `administer-platform` | `staff-companies`, `staff-license-reissue`, `staff-data-boundary` | 2, 3 |
| 14 | `run-scheduled-jobs` | `cron-routes`, `data-retention` | 1 |

Scheduled work that belongs to a feature (offline detection, domain verification) is specified in
that feature's change; `run-scheduled-jobs` owns the cron mechanism and retention.
