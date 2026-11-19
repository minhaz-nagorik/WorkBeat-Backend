# Cron schedules (systemd)

The API runs scheduled work only when the scheduler calls a `/cron/<job>` route (rule 8,
`docs/operations/scheduled-jobs.md`). These units do that from one host.

| Timer | Schedule (UTC) | Route |
|---|---|---|
| `workbeat-cron@usage-summary.timer` | hourly | `/cron/usage-summary` |
| `workbeat-cron@cleanup.timer` | daily 02:00 | `/cron/cleanup` |

`heartbeat-check`, `domain-verify`, `token-expiry` and `alert-digest` answer `404` until they are
built; add a timer for each when it lands.

## Install (once, on one host only)

```bash
sudo install -d -m 700 /etc/workbeat
sudo install -m 600 /dev/null /etc/workbeat/cron.env
sudoedit /etc/workbeat/cron.env        # API_URL=https://<api host>  and  CRON_SECRET=<the API's value>
sudo cp db/cron/workbeat-cron@.service db/cron/workbeat-cron@*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now workbeat-cron@usage-summary.timer workbeat-cron@cleanup.timer
```

## Check

```bash
systemctl list-timers 'workbeat-cron@*'
journalctl -u 'workbeat-cron@cleanup.service' -n 20   # curl output: the job's JSON or the error
sudo systemctl start workbeat-cron@cleanup.service    # run one now
```

Rotating the secret: change `CRON_SECRET` in the API and in `/etc/workbeat/cron.env` together.
