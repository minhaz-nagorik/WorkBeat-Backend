// Per-day usage summaries (summarize-usage, B28). A company day in usage_days is summarized in
// usage_hours, usage_apps and usage_domains; reports read those for it and raw rows otherwise.
// Days and hours are company-timezone days: callers set the transaction's TimeZone first.
import { LIMITS } from './contract';
import type { Tx } from './core';

export type Rows = Record<string, number>;
export const add = (rows: Rows, table: string, n: number | null) => { if (n) rows[table] = (rows[table] ?? 0) + n; };

// The ingest of a late batch and the job building that day take this lock, so neither misses
// the other's rows (design "Late batches"). Two-key form: never collides with the job locks.
async function lockDay(c: Tx, companyId: string, day: string) {
  await c.query("SELECT pg_advisory_xact_lock(hashtext('usage'), hashtext($1::text || ':' || $2::text))", [companyId, day]);
}

// Locks the company row against a timezone change until commit, then uses its timezone.
// Taken before any day lock, by ingest and by the job alike, so the two cannot deadlock.
async function companyTz(c: Tx, companyId: string) {
  const { rows: [co] } = await c.query('SELECT timezone FROM companies WHERE id = $1 FOR SHARE', [companyId]);
  await c.query("SELECT set_config('timezone', $1, true)", [co.timezone]);
}

const RAW = (col: string) => `company_id = $1 AND ${col} >= $2::date AND ${col} < $2::date + 1 AND ($3::uuid IS NULL OR employee_id = $3)`;

// Rebuilds one company day, or one employee's part of it. Marks the day built when whole.
async function buildDay(c: Tx, companyId: string, day: string, employeeId: string | null, rows: Rows) {
  const p = [companyId, day, employeeId];
  for (const t of ['usage_hours', 'usage_apps', 'usage_domains'])
    add(rows, t, (await c.query(`DELETE FROM ${t} WHERE company_id = $1 AND day = $2 AND ($3::uuid IS NULL OR employee_id = $3)`, p)).rowCount);
  add(rows, 'usage_hours', (await c.query(
    `INSERT INTO usage_hours (company_id, employee_id, day, hour, tracked_seconds, sessions, buckets, active_samples, total_samples, idle_seconds, first_at, last_at)
     SELECT $1, employee_id, $2::date, hour, sum(tracked), sum(sessions), sum(buckets), sum(act), sum(tot), sum(idle), min(first_at), max(last_at)
       FROM (SELECT employee_id, extract(hour FROM started_at)::int AS hour, duration_seconds::bigint AS tracked, 1 AS sessions, 0 AS buckets,
                    0::bigint AS act, 0::bigint AS tot, 0::numeric AS idle, started_at AS first_at, ended_at AS last_at
               FROM app_sessions WHERE ${RAW('started_at')}
             UNION ALL
             SELECT employee_id, extract(hour FROM bucket_start)::int, 0, 0, 1, active_samples, total_samples, 0, NULL, NULL
               FROM activity_buckets WHERE ${RAW('bucket_start')}
             UNION ALL
             SELECT employee_id, extract(hour FROM started_at)::int, 0, 0, 0, 0, 0, extract(epoch FROM ended_at - started_at), NULL, NULL
               FROM idle_intervals WHERE ${RAW('started_at')}) x
      GROUP BY employee_id, hour`, p)).rowCount);
  add(rows, 'usage_apps', (await c.query(
    `INSERT INTO usage_apps (company_id, employee_id, day, app_name, seconds)
     SELECT $1, employee_id, $2::date, app_name, sum(duration_seconds) FROM app_sessions WHERE ${RAW('started_at')} GROUP BY employee_id, app_name`, p)).rowCount);
  add(rows, 'usage_domains', (await c.query(
    `INSERT INTO usage_domains (company_id, employee_id, day, domain, seconds)
     SELECT $1, employee_id, $2::date, domain, sum(duration_seconds) FROM url_visits WHERE ${RAW('visited_at')} GROUP BY employee_id, domain`, p)).rowCount);
  if (employeeId === null)
    add(rows, 'usage_days', (await c.query(
      'INSERT INTO usage_days (company_id, day) VALUES ($1, $2) ON CONFLICT (company_id, day) DO UPDATE SET built_at = now()', [companyId, day])).rowCount);
}

// Ingest: after storing a batch, rebuild the employee's summarized days it touched (usage-summaries
// "A late batch updates its day at once"). One query when every row is from today.
export async function rebuildLateDays(c: Tx, companyId: string, employeeId: string, times: Date[]) {
  if (!times.length) return;
  const { rows: past } = await c.query(
    `SELECT DISTINCT to_char((t AT TIME ZONE co.timezone)::date, 'YYYY-MM-DD') AS d FROM companies co, unnest($2::timestamptz[]) t
      WHERE co.id = $1 AND (t AT TIME ZONE co.timezone)::date < (now() AT TIME ZONE co.timezone)::date ORDER BY 1`,
    [companyId, times.map((t) => t.toISOString())],
  );
  if (!past.length) return;
  await companyTz(c, companyId);
  for (const { d } of past) {
    await lockDay(c, companyId, d); // waits for a build of the same day in progress
    if ((await c.query('SELECT 1 FROM usage_days WHERE company_id = $1 AND day = $2', [companyId, d])).rowCount)
      await buildDay(c, companyId, d, employeeId, {});
  }
}

// A timezone change: days and hours move, so the company's summaries go; the job rebuilds them.
export async function clearSummaries(c: Tx) {
  for (const t of ['usage_days', 'usage_hours', 'usage_apps', 'usage_domains'])
    await c.query(`DELETE FROM ${t} WHERE company_id = app_company_id()`);
}

// One transaction of a job run, in system scope under the job lock; null when another run holds it.
export type JobTx = <T>(fn: (c: Tx) => Promise<T>) => Promise<{ value: T } | null>;

// POST /cron/usage-summary: retention first, then every finished day not built, newest first.
export async function usageSummaryJob(tx: JobTx, rows: Rows) {
  const start = Date.now();
  const first = await tx(async (c) => {
    for (const t of ['usage_hours', 'usage_apps', 'usage_domains', 'usage_days'])
      add(rows, t, (await c.query(
        `DELETE FROM ${t} u USING companies co
          WHERE u.company_id = co.id AND u.day < (now() AT TIME ZONE co.timezone)::date - co.data_retention_days + 1`)).rowCount);
    const { rows: todo } = await c.query(
      `SELECT co.id, to_char(g::date, 'YYYY-MM-DD') AS d
         FROM companies co,
              generate_series((now() AT TIME ZONE co.timezone)::date - co.data_retention_days + 1, (now() AT TIME ZONE co.timezone)::date - 1, interval '1 day') g
        WHERE NOT EXISTS (SELECT 1 FROM usage_days u WHERE u.company_id = co.id AND u.day = g::date)
        ORDER BY g DESC, co.id`);
    return todo as { id: string; d: string }[];
  });
  if (!first) return { skipped: true, more: false };
  for (const { id, d } of first.value) {
    if (Date.now() - start > LIMITS.usageSummaryBudgetMs) return { skipped: false, more: true };
    const done = await tx(async (c) => {
      await companyTz(c, id);
      await lockDay(c, id, d);
      // Still a finished, retained day not built (a timezone change or another writer may have moved on).
      const { rows: [ok] } = await c.query(
        `SELECT $2::date < now()::date AND $2::date >= now()::date - data_retention_days + 1
                AND NOT EXISTS (SELECT 1 FROM usage_days WHERE company_id = $1 AND day = $2) AS go
           FROM companies WHERE id = $1`, [id, d]);
      if (ok.go) await buildDay(c, id, d, null, rows);
    });
    if (!done) return { skipped: false, more: true }; // another run took the lock: it carries on
  }
  return { skipped: false, more: false };
}
