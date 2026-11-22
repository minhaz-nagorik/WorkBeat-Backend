> **Read first — this task list is not the requirement.**
> Capability: `agent-policy-events`
> The requirements are in [`specs/`](specs/). Run `cd docs && openspec show push-policy-events`.
> Contract: [agent-contract.md](../../../core/api/agent-contract.md) · Decision: B32.

## 1. Database

- [x] 1.1 `0014_policy_events.sql`: `AFTER UPDATE` triggers on `companies` and `employee_monitoring_settings` notify `policy_events` with the company or employee ID when `policy_version` changes; `devices` notifies the device ID when `released_at` or `key_hash` changes
- [x] 1.2 `db/tests/0014_policy_events_test.sql`: the triggers exist and fire only on a version change

## 2. API

- [x] 2.1 Move the policy body and ETag into one function shared by `GET /v1/agents/policy` and the stream
- [x] 2.2 `authDevice` also accepts a key hash, so a push re-checks access without holding the key
- [x] 2.3 `PolicyEvents`: one `LISTEN` connection, reconnecting; open streams by company, employee and device; a random 0–5 s push per stream, one pending at a time; a 25 s keepalive
- [x] 2.4 `GET /v1/agents/events`: authenticate in a short transaction, release it, hijack the reply, register, push the current policy
- [x] 2.5 Tests: event framing, routing a notification to the right streams, one pending push per stream

## 3. Hosting

- ⏸ 3.1 Load balancer idle timeout above 25 s, response buffering off for `text/event-stream`, raised file-descriptor limit — **Waiting on** a hosting choice
