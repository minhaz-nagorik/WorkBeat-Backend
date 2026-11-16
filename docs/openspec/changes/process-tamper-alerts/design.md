## Decisions

### Tamper events are exempt from the B7 time window

**Amends:** B7 (records outside [now − 8 days, now + 1 day] are dropped).
**Why:** D24 says tamper events are never dropped, and the agents keep them past the 7-day store cap
(D7), so a device offline for longer sends events older than 8 days. Plan v3.5 outranks B7. A
future `occurred_at` is clamped to the server time instead, so a forward clock cannot pin an event
at the top of the feed.

### `offline` is never an agent event

**Amends:** PRD "Online status and tamper detection", which lists `offline` among the events the
agent reports.
**Why:** D24 and Plan-v3.5 §4.1 make `offline` backend-only; the agents' `tamper-detection` spec
says they never send it. A `POST /v1/agents/tamper` with `offline` is refused with `422`.

### Digests run from a new `/cron/alert-digest` route, in the company time zone

**Amends:** Plan-v3.5 §6.4, whose job table has no digest job.
**Why:** hourly and daily delivery (`companies.alert_email.delivery`) needs a scheduled sender, and
scheduled work runs only through `/cron/*` (Plan §3, B10). The daily digest is sent by the run inside the
09:00 local hour of `companies.timezone` (B19, migration 0002).
