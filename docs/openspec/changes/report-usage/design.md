## Context

Reports are computed on read from the partitioned activity tables (data-model.md "Not modelled").
Four choices were not fixed upstream.

## Decisions

### Day and week boundaries use `companies.timezone`
Amends: data-model.md `companies` (no time zone column). The PRD's calendar and Monday-start
timesheet need a local day; UTC days split a working day in most time zones. Migration `0002`
adds `timezone text NOT NULL DEFAULT 'UTC'` (an IANA name). A `company_admin` sets it in
`configure-company` (`company-settings`); until then a company reports in UTC.

### Browser app sessions are replaced by their URL visits in the productivity split
Refines: PRD "Activity levels, productivity, calendar and timesheets" ("each app session is
matched by app name, and each URL visit by domain"). Counting both would count browser time twice.
The prototype's split already leaves the browser's app time out and counts its sites instead. The
browser list (bundle IDs and process names) lives in `packages/shared`.

### Ranges are clamped to the retention window, not refused
Refines: PRD "Retention and suspension". A "Last 30 days" preset on a company that keeps 7 days
returns the 7 days it has, with the effective `from` in the response. Only malformed ranges are
refused.

### CSV export is synchronous with a row cap
Plan-v3.5 §4.4 lists CSV export without a shape. A streamed export would hold a pooled
transaction-mode connection for minutes; an async job needs a job table and storage nobody asked
for. A cap from `packages/shared` keeps one request bounded; over the cap the caller narrows the
range. Revisit with an async export if the cap is hit in practice.
