// POST /cron/cleanup (run-scheduled-jobs `data-retention`, B15): partitions (created ahead, dropped past
// 90 days), then each company's activity past its retention, old ingest_batches and resolved tamper events.
// Screenshots are not deleted yet: rows and their R2 files go together in a later change (task 3.2).
import { LIMITS } from './contract';
import { add, JobTx, Rows } from './usage';

const DAY = 24 * 3600 * 1000;
const ACTIVITY: [table: string, col: string][] = [
  ['app_sessions', 'started_at'], ['url_visits', 'visited_at'], ['activity_buckets', 'bucket_start'], ['idle_intervals', 'started_at'],
];

type Result = { skipped: boolean; more: boolean };

export async function cleanupJob(tx: JobTx, rows: Rows): Promise<Result> {
  const start = new Date(), t0 = Date.now();
  const late = () => Date.now() - t0 > LIMITS.cleanupBudgetMs;

  // Retention is read once, at the run's start; every cut-off is fixed to that moment (task 3.6).
  // Whole months past the 90-day maximum (B13) go first: no retention is longer, and a run that
  // ends on its budget must not leave them for ever.
  const first = await tx(async (c) => {
    await c.query('SELECT cron_ensure_month_partitions()');
    add(rows, 'partitions_dropped', (await c.query('SELECT cron_drop_old_partitions(90) AS n')).rows[0].n);
    const { rows: cos } = await c.query('SELECT id, data_retention_days AS days FROM companies ORDER BY id');
    return cos as { id: string; days: number }[];
  });
  if (!first) return { skipped: true, more: false };
  const cutoff = (days: number) => new Date(start.getTime() - days * DAY);

  // Activity, oldest first. A batch is one company day of one table: the time range lets Postgres
  // skip other months' partitions. A row exactly at the cut-off is kept (strict <).
  // shortcut: the indexes lead with (company_id, employee_id), so each batch reads the company's
  // index entries for the month; add (company_id, <time>) indexes if the load test (3.5) says so.
  for (const co of first.value) {
    const cut = cutoff(co.days);
    for (const [t, col] of ACTIVITY) {
      const oldest = await tx(async (c) => (await c.query(`SELECT min(${col}) AS m FROM ${t} WHERE company_id = $1 AND ${col} < $2`, [co.id, cut])).rows[0].m as Date | null);
      if (!oldest) return { skipped: false, more: true };
      for (let from = oldest.value; from && from < cut;) {
        if (late()) return { skipped: false, more: true };
        const to = new Date(Math.min(from.getTime() + DAY, cut.getTime()));
        const done = await tx(async (c) => add(rows, t, (await c.query(
          `DELETE FROM ${t} WHERE company_id = $1 AND ${col} >= $2 AND ${col} < $3`, [co.id, from, to])).rowCount));
        if (!done) return { skipped: false, more: true }; // another run holds the lock: it carries on
        from = to;
      }
    }
  }

  // Short-lived and resolved records, in batches. Open tamper events stay: device status depends on them.
  const sweeps: [string, string, unknown[]][] = [
    ['ingest_batches', 'received_at < $1', [new Date(start.getTime() - LIMITS.ingestBatchKeepDays * DAY)]],
    ...first.value.map((co): [string, string, unknown[]] =>
      ['tamper_events', 'company_id = $1 AND resolved_at IS NOT NULL AND occurred_at < $2', [co.id, cutoff(co.days)]]),
  ];
  for (const [t, where, params] of sweeps) {
    for (;;) {
      if (late()) return { skipped: false, more: true };
      const n = await tx(async (c) => (await c.query(
        `DELETE FROM ${t} WHERE ctid = ANY(ARRAY(SELECT ctid FROM ${t} WHERE ${where} LIMIT ${LIMITS.cleanupBatchRows}))`, params)).rowCount ?? 0);
      if (!n) return { skipped: false, more: true };
      add(rows, t, n.value);
      if (n.value < LIMITS.cleanupBatchRows) break;
    }
  }
  return { skipped: false, more: false };
}
