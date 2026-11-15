## Decisions

### A screenshot outside the time window is refused, not dropped

**Amends:** B7 ("dropped and counted; the batch is still accepted").
**Why:** B7 exists so one skewed record cannot quarantine a whole activity batch. A screenshot
request carries exactly one record, so there is nothing else to save; accepting it and returning
no upload URL would leave the agent with no defined reaction. `422 VALIDATION_FAILED` is in the
agents' status table (quarantine), and an agent keeps at most 7 days (D7), so a healthy device
never hits it.

### Screenshot path uses the screenshot ID, not a timestamp

**Amends:** PRD "Screenshots" (`{company_id}/{device_id}/{timestamp}.jpg`).
**Why:** the ID is the agent's UUIDv7 and the idempotency key (D13); the schema already stores
`{company_id}/{device_id}/{id}.jpg` as unique. Plan v3.2 and the schema outrank the PRD.
