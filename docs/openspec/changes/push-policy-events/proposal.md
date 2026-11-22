## Why

A device learns of a policy change at its next heartbeat, up to 5 minutes later, or at its 30-minute
poll. The product owner wants block rules, pauses and settings enforced within seconds of being
saved (22 Nov 2026). Agents cannot be called, so they hold a stream and the API writes into it.

## What Changes

- **New route** `GET /v1/agents/events`: a Server-Sent Events stream per device. On connect it
  sends the device's current policy; after any change to that policy it sends the new one.
- **Pushes are spread** over a random 0–5 seconds per device, so one company-wide change does not
  build every device's policy in the same instant.
- **Change detection in the database**: the triggers that raise `policy_version` also
  `pg_notify('policy_events', …)`. Notifications are delivered on commit only, and identical ones
  in a transaction are folded into one, so a bulk import sends one event.
- **Revocation and release close the stream**; the agent's reopen then gets `401`.
- `GET /v1/agents/policy`, the heartbeat's `policy_version` and the ETag are unchanged.

## Capabilities

### New Capabilities

- `agent-policy-events`: the stream route, what it sends and when, and when it closes.

### Modified Capabilities

None. `agent-policy` keeps its body and ETag; the stream sends that same body.

## Impact

- Routes: `GET /v1/agents/events`.
- Schema: migration `0014_policy_events.sql` (notify triggers), self-check in `db/tests/`.
- Decision B32: a held stream releases its transaction after authentication (amends B2), and each
  open stream keeps an in-process keepalive and push timer (not scheduled work; rule 8 unchanged).
- Consumed by the Mac agent's `policy-events` (change `stream-policy-events`). The Windows agent may
  ignore the route; nothing it calls changes.
- Hosting: long-lived responses, buffering off, idle timeout above 25 s.
