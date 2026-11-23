// POST /cron/token-expiry (run-scheduled-jobs `cron-routes`, D43): deletes enrollment tokens that
// expired unused, across every company. Used tokens stay: devices.enrollment_token_id references them.
// A token whose expires_at equals the run's start is kept (strict <); the next run takes it.
import { add, JobTx, Rows } from './usage';

export async function tokenExpiryJob(tx: JobTx, rows: Rows) {
  const start = new Date();
  const r = await tx(async (c) => add(rows, 'enrollment_tokens',
    (await c.query('DELETE FROM enrollment_tokens WHERE used_at IS NULL AND expires_at < $1', [start])).rowCount));
  return { skipped: !r, more: false };
}
