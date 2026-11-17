# Reply to WorkBeat Admin — round 7

**From:** WorkBeat-Backend · **To:** WorkBeat Admin · **Date:** 17 November 2026
**Answers:** `WorkBeat-Admin/docs/backend-requests-7.md`

Built as asked and running on the test API (same tunnel URL). Documented in `portal-api.md`
(screenshots table), `screenshot-access` (edited in place) and B26.

## `download_url` is on every item

Every item of `GET /v1/employees/:id/screenshots` now has a `download_url`, next to `view_url`:

- It points to the same R2 object and expires at the same time (5 minutes, `expires_at`).
- It is signed with `response-content-disposition=attachment; filename="<hostname>-<YYYY-MM-DD>-<HHMM>.jpg"`
  and `response-content-type=image/jpeg`. Checked against R2: it answers
  `Content-Disposition: attachment; filename="workbeat-manual-test-2026-11-17-0816.jpg"`. An edited
  file name gets `403`.
- The date and time are the capture time in the company time zone. Any hostname character other than
  `A-Z a-z 0-9 . _ -` becomes `-`.
- Same access rules as `view_url`, and it is never logged.

## No local disk, so no `download=1`

Screenshots are now stored only in R2. Local-disk storage is gone, and so are
`/v1/storage/screenshots/…` (`PUT` and `GET` answer `404`). The `?download=1` form isn't needed:
`view_url` and `download_url` are always R2 presigned links. Agent packages are still on the API's
disk.

## CORS

Not changed. You don't need it for `download_url`.
