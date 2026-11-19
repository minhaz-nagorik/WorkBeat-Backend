// /cron/<job>: scheduled work, called by the server's scheduler (run-scheduled-jobs `cron-routes`, B10).
// X-Cron-Secret in constant time, system scope and the job's advisory lock in every transaction,
// one log line per run. No in-process timers (rule 8).
import { Controller, Headers, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { ApiError, config, Db, sha256, Tx } from './core';
import type { LogCtx } from './http';
import { JobTx, Rows, usageSummaryJob } from './usage';

type Job = (tx: JobTx, rows: Rows) => Promise<{ skipped: boolean; more: boolean }>;
const JOBS: Record<string, Job> = {
  'usage-summary': usageSummaryJob,
};

// Hashing first gives equal lengths, so a prefix or longer value is refused without throwing.
function secretOk(got: string | undefined) {
  const want = config().CRON_SECRET;
  if (!want || typeof got !== 'string') return false;
  return timingSafeEqual(Buffer.from(sha256(got), 'hex'), Buffer.from(sha256(want), 'hex'));
}

@Controller('cron')
export class CronController {
  constructor(@Inject(Db) private db: Db) {}

  @Post(':job')
  @HttpCode(200)
  async run(@Req() req: FastifyRequest, @Param('job') job: string, @Headers('x-cron-secret') secret: string | undefined) {
    if (!secretOk(secret)) throw new ApiError(401, 'UNAUTHENTICATED', 'Cron secret required');
    const fn = Object.hasOwn(JOBS, job) ? JOBS[job] : undefined;
    if (!fn) throw new ApiError(404, 'NOT_FOUND', 'Not found');
    (req as FastifyRequest & { wb?: LogCtx }).wb = { scope: 'system' };
    const tx: JobTx = (work) => this.db.tx(async (c: Tx) => {
      await c.query("SELECT set_config('app.scope', 'system', true)");
      const { rows: [l] } = await c.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', ['cron:' + job]);
      return l.ok ? { value: await work(c) } : null;
    });
    const started = new Date(), rows: Rows = {};
    try {
      const { skipped, more } = await fn(tx, rows);
      const duration_ms = Date.now() - started.getTime();
      console.log(JSON.stringify({ t: new Date(), level: 'info', job, duration_ms, rows_affected: rows, skipped, more }));
      return { data: { job, started_at: started, duration_ms, rows_affected: rows, skipped, more } };
    } catch (e) {
      console.error(JSON.stringify({ t: new Date(), level: 'error', job, err: (e as Error)?.name, pg_code: (e as { code?: string })?.code }));
      throw e;
    }
  }
}
