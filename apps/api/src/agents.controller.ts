// /v1/agents/*: heartbeat, policy, activity, screenshots, tamper.
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { activityBody, HEALTH_FIELDS, heartbeatBody, LIMITS, screenshotBody, tamperBody, uuid } from './contract';
import { ApiError, Db, parse, sha256 } from './core';
import { authDevice, pauseInForce, policyVersion } from './device';
import { buildPolicy } from './policy';
import { PolicyEvents } from './policy-events';
import { baseUrl, tag } from './http';
import { Storage, thumbPath } from './storage';
import { rebuildLateDays } from './usage';

const inWindow = (d: Date) => {
  const t = d.getTime(), now = Date.now();
  return t >= now - LIMITS.windowPastMs && t <= now + LIMITS.windowFutureMs;
};
const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

@Controller('v1/agents')
export class AgentsController {
  constructor(
    @Inject(Db) private db: Db,
    @Inject(Storage) private storage: Storage,
    @Inject(PolicyEvents) private events_: PolicyEvents,
  ) {}

  // receive-device-health/heartbeat + notice-acknowledgement. Still written when answered 402 (D5).
  @Post('heartbeat')
  @HttpCode(200)
  async heartbeat(@Req() req: FastifyRequest, @Headers('x-device-key') key: string | undefined, @Body() raw: unknown) {
    const out = await this.db.tx(async (c) => {
      const { dev, billing } = await authDevice(c, key, 'normal');
      tag(req, dev);
      const b = parse(heartbeatBody, raw);
      const health = Object.fromEntries(HEALTH_FIELDS.map((f) => [f, b[f] ?? null]));
      await c.query(
        `UPDATE devices SET agent_version = $2, os_version = coalesce($3, os_version), reported_policy_version = $4,
                helper_status = $5, browser_access = $6, permissions = $7, active_pause_id = $8, health = $9,
                last_heartbeat_at = greatest(last_heartbeat_at, now()), offline_since = NULL,
                last_input_at = now() - make_interval(secs => $10)
          WHERE id = $1`,
        [dev.device_id, b.agent_version, b.os_version ?? null, b.policy_version ?? null, json(b.helper_status),
         json(b.browser_access), json(b.permissions), b.active_pause_id ?? null, json(health), b.input_idle_seconds ?? null],
      );
      await c.query(
        "UPDATE tamper_events SET resolved_at = now() WHERE device_id = $1 AND event_type = 'offline' AND resolved_at IS NULL",
        [dev.device_id],
      );
      // Both halves present and a version the company published (D25).
      if (b.notice_version && b.notice_acknowledged_at) {
        const ins = await c.query(
          `INSERT INTO notice_acknowledgements (company_id, device_id, employee_id, notice_version, acknowledged_at)
           SELECT $1, $2, $3, $4, $5 FROM companies WHERE id = $1 AND notice_version >= $4
           ON CONFLICT (device_id, employee_id, notice_version) DO NOTHING`,
          [dev.company_id, dev.device_id, dev.employee_id, b.notice_version, b.notice_acknowledged_at],
        );
        if (ins.rowCount)
          await c.query('UPDATE devices SET notice_ack_version = greatest(coalesce(notice_ack_version, 0), $2) WHERE id = $1', [dev.device_id, b.notice_version]);
      }
      if (billing) return { billing };
      return { data: { policy_version: await policyVersion(c, dev), monitoring_pause: await pauseInForce(c, dev.employee_id) } };
    });
    if (out.billing) throw out.billing;
    return { data: out.data };
  }

  // serve-agent-policy/agent-policy. One snapshot; ETag = hash of the body (D8).
  @Get('policy')
  async policy(@Req() req: FastifyRequest, @Headers('x-device-key') key: string | undefined, @Res() res: FastifyReply) {
    const { body, etag } = await this.db.tx(async (c) => {
      const { dev, billing } = await authDevice(c, key, 'normal');
      tag(req, dev);
      if (billing) throw billing;
      return buildPolicy(c, dev, this.storage, baseUrl(req));
    }, { snapshot: true });
    res.header('ETag', etag);
    if (req.headers['if-none-match'] === etag) return res.status(304).send();
    return res.status(200).type('application/json').send(body);
  }

  // agent-policy-events (B32): authenticated and first policy in one short snapshot, then the
  // connection is handed to PolicyEvents and holds no database connection.
  @Get('events')
  async events(@Req() req: FastifyRequest, @Headers('x-device-key') key: string | undefined, @Res() res: FastifyReply) {
    const base = baseUrl(req);
    const { dev, policy } = await this.db.tx(async (c) => {
      const { dev, billing } = await authDevice(c, key, 'normal');
      tag(req, dev);
      if (billing) throw billing;
      return { dev, policy: await buildPolicy(c, dev, this.storage, base) };
    }, { snapshot: true });
    res.hijack();
    this.events_.open(res.raw, { ...dev, key_hash: sha256(key ?? ''), base }, policy);
  }

  // ingest-activity/activity-ingestion. One transaction; ingest_batches is the idempotency record (D13).
  @Post('activity')
  @HttpCode(200)
  async activity(@Req() req: FastifyRequest, @Headers('x-device-key') key: string | undefined, @Headers('idempotency-key') idem: string | undefined, @Body() raw: unknown) {
    return this.db.tx(async (c) => {
      const { dev, billing } = await authDevice(c, key, 'upload');
      tag(req, dev);
      if (billing) throw billing;
      const b = parse(activityBody, raw);
      if (idem !== b.batch_id) throw new ApiError(400, 'VALIDATION_FAILED', 'Idempotency-Key must equal batch_id', { fields: ['Idempotency-Key'] });

      const sessions = b.app_sessions.filter((r) => inWindow(r.started_at)).map(({ clock_suspect, ...r }) => ({ ...r, clock_flag: r.clock_flag || !!clock_suspect }));
      const visits = b.url_visits.filter((r) => inWindow(r.visited_at));
      const idles = b.idle_intervals.filter((r) => inWindow(r.started_at));
      const inBuckets = b.activity_buckets.filter((r) => inWindow(r.bucket_start));
      const buckets = [...new Map(inBuckets.map((r) => [r.bucket_start.getTime(), r])).values()]; // last one wins
      const dropped =
        b.app_sessions.length - sessions.length + b.url_visits.length - visits.length +
        b.idle_intervals.length - idles.length + b.activity_buckets.length - inBuckets.length;
      const counts = {
        app_sessions: sessions.length, url_visits: visits.length,
        activity_buckets: buckets.length, idle_intervals: idles.length,
      };
      const bodyHash = sha256(JSON.stringify(raw));

      const ins = await c.query(
        `INSERT INTO ingest_batches (device_id, batch_id, company_id, counts, body_sha256) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (device_id, batch_id) DO NOTHING`,
        [dev.device_id, b.batch_id, dev.company_id, JSON.stringify({ accepted: counts, dropped_out_of_window: dropped }), bodyHash],
      );
      if (!ins.rowCount) {
        const { rows: [prev] } = await c.query('SELECT counts, body_sha256 FROM ingest_batches WHERE device_id = $1 AND batch_id = $2', [dev.device_id, b.batch_id]);
        if (prev.body_sha256 !== bodyHash) throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Batch ID reused with a different body');
        return { data: { batch_id: b.batch_id, ...prev.counts } };
      }

      const stamp = [dev.company_id, dev.device_id, dev.employee_id, b.batch_id];
      if (sessions.length)
        await c.query(
          `INSERT INTO app_sessions (company_id, device_id, employee_id, batch_id, os_user, bundle_id, app_name, process_name,
                                     window_title, started_at, ended_at, duration_seconds, clock_flag)
           SELECT $1, $2, $3, $4, x."session_user", x.bundle_id, x.app_name, x.process_name, x.window_title, x.started_at,
                  x.ended_at, x.duration_seconds, x.clock_flag
             FROM jsonb_to_recordset($5) AS x("session_user" text, bundle_id text, app_name text, process_name text,
                  window_title text, started_at timestamptz, ended_at timestamptz, duration_seconds int, clock_flag bool)`,
          [...stamp, JSON.stringify(sessions)],
        );
      if (visits.length)
        await c.query(
          `INSERT INTO url_visits (company_id, device_id, employee_id, batch_id, os_user, browser, url, domain, visited_at, duration_seconds)
           SELECT $1, $2, $3, $4, x."session_user", x.browser, x.url, x.domain, x.visited_at, x.duration_seconds
             FROM jsonb_to_recordset($5) AS x("session_user" text, browser text, url text, domain text, visited_at timestamptz, duration_seconds int)`,
          [...stamp, JSON.stringify(visits)],
        );
      if (idles.length)
        await c.query(
          `INSERT INTO idle_intervals (company_id, device_id, employee_id, batch_id, os_user, started_at, ended_at)
           SELECT $1, $2, $3, $4, x."session_user", x.started_at, x.ended_at
             FROM jsonb_to_recordset($5) AS x("session_user" text, started_at timestamptz, ended_at timestamptz)`,
          [...stamp, JSON.stringify(idles)],
        );
      if (buckets.length)
        await c.query(
          `INSERT INTO activity_buckets (company_id, device_id, employee_id, bucket_start, active_samples, total_samples)
           SELECT $1, $2, $3, x.bucket_start, x.active_samples, x.total_samples
             FROM jsonb_to_recordset($4) AS x(bucket_start timestamptz, active_samples int, total_samples int)
           ON CONFLICT (device_id, bucket_start) DO UPDATE
              SET active_samples = excluded.active_samples, total_samples = excluded.total_samples`,
          [dev.company_id, dev.device_id, dev.employee_id, JSON.stringify(buckets)],
        );
      // Rows on an already summarized day rebuild that employee-day now (usage-summaries, B28).
      await rebuildLateDays(c, dev.company_id, dev.employee_id,
        [...sessions.map((r) => r.started_at), ...visits.map((r) => r.visited_at), ...idles.map((r) => r.started_at), ...buckets.map((r) => r.bucket_start)]);
      return { data: { batch_id: b.batch_id, accepted: counts, dropped_out_of_window: dropped } };
    });
  }

  // ingest-activity/screenshot-upload: pending row + signed PUT URL.
  @Post('screenshots')
  async screenshot(@Req() req: FastifyRequest, @Headers('x-device-key') key: string | undefined, @Headers('idempotency-key') idem: string | undefined, @Body() raw: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    return this.db.tx(async (c) => {
      const { dev, billing } = await authDevice(c, key, 'upload');
      tag(req, dev);
      if (billing) throw billing;
      const b = parse(screenshotBody, raw);
      if (idem !== b.id) throw new ApiError(400, 'VALIDATION_FAILED', 'Idempotency-Key must equal id', { fields: ['Idempotency-Key'] });
      if (b.bytes > LIMITS.screenshotMaxBytes) throw new ApiError(422, 'VALIDATION_FAILED', 'Screenshot too large', { fields: ['bytes'] });
      if (!inWindow(b.captured_at)) throw new ApiError(422, 'VALIDATION_FAILED', 'captured_at outside the accepted window', { fields: ['captured_at'] });

      const path = `${dev.company_id}/${dev.device_id}/${b.id}.jpg`;
      // A thumbnail is optional and never a reason to refuse (screenshot-upload "A screenshot may come with a thumbnail").
      const thumb = b.thumb_bytes && b.thumb_bytes > 0 && b.thumb_bytes <= LIMITS.screenshotThumbMaxBytes ? b.thumb_bytes : null;
      const ins = await c.query(
        `INSERT INTO screenshots (id, company_id, device_id, employee_id, captured_at, storage_path, bytes, thumb_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
        [b.id, dev.company_id, dev.device_id, dev.employee_id, b.captured_at, path, b.bytes, thumb],
      );
      let status = 'pending';
      if (ins.rowCount) res.status(201);
      else {
        // RLS hides other companies' rows, so "not mine" and "not found" both mean reused.
        const { rows: [s] } = await c.query('SELECT device_id, captured_at, bytes, status FROM screenshots WHERE id = $1', [b.id]);
        if (!s || s.device_id !== dev.device_id || s.bytes !== b.bytes || s.captured_at.getTime() !== b.captured_at.getTime())
          throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Screenshot ID reused');
        status = s.status;
        // A retry may re-encode its thumbnail to another size: keep the latest while pending.
        if (status === 'pending') await c.query('UPDATE screenshots SET thumb_bytes = $2 WHERE id = $1', [b.id, thumb]);
        res.status(200);
      }
      const exp = Math.floor(Date.now() / 1000) + LIMITS.screenshotUploadUrlSeconds;
      const pending = status === 'pending';
      return {
        data: {
          id: b.id,
          status,
          upload_url: pending ? this.storage.sign(baseUrl(req), 'PUT', 'screenshots', path, exp) : null,
          thumb_upload_url: pending && thumb ? this.storage.sign(baseUrl(req), 'PUT', 'screenshots', thumbPath(path), exp) : null,
          expires_at: pending ? new Date(exp * 1000) : null,
        },
      };
    });
  }

  @Post('screenshots/:id/confirm')
  @HttpCode(200)
  async confirm(@Req() req: FastifyRequest, @Headers('x-device-key') key: string | undefined, @Param('id') id: string) {
    const notFound = new ApiError(404, 'NOT_FOUND', 'Screenshot not found');
    const done = { data: { id, status: 'uploaded' } };
    // The R2 checks run between two short transactions: a slow R2 must never hold a pooled connection.
    const s = await this.db.tx(async (c) => {
      const { dev, billing } = await authDevice(c, key, 'upload');
      tag(req, dev);
      if (billing) throw billing;
      if (!uuid.safeParse(id).success) throw notFound;
      const { rows: [s] } = await c.query('SELECT storage_path, bytes, thumb_bytes, status FROM screenshots WHERE id = $1 AND device_id = $2', [id, dev.device_id]);
      if (!s) throw notFound;
      return s;
    });
    if (s.status === 'uploaded') return done;
    const size = await this.storage.size('screenshots', s.storage_path);
    if (size !== s.bytes) {
      if (size !== null) await this.storage.remove('screenshots', s.storage_path);
      throw new ApiError(422, 'VALIDATION_FAILED', 'Uploaded object missing or wrong size', { fields: ['bytes'] });
    }
    // Keep the thumbnail only when whole; a missing or partial one never fails the confirmation.
    let thumb = s.thumb_bytes as number | null;
    if (thumb !== null) {
      const t = await this.storage.size('screenshots', thumbPath(s.storage_path));
      if (t !== thumb) {
        if (t !== null) await this.storage.remove('screenshots', thumbPath(s.storage_path));
        thumb = null;
      }
    }
    return this.db.tx(async (c) => {
      const { dev, billing } = await authDevice(c, key, 'upload');
      if (billing) throw billing;
      // Only a pending row flips; a retry that changed thumb_bytes meanwhile loses its thumbnail, never the screenshot.
      const up = await c.query(
        `UPDATE screenshots SET status = 'uploaded', uploaded_at = coalesce(uploaded_at, now()),
                thumb_bytes = CASE WHEN thumb_bytes IS NOT DISTINCT FROM $3::int THEN $2::int END
          WHERE id = $1 AND device_id = $4 AND status = 'pending'`,
        [id, thumb, s.thumb_bytes, dev.device_id],
      );
      // 0 rows: a concurrent confirm won (still answer uploaded), or the row is gone (404).
      if (!up.rowCount && !(await c.query('SELECT 1 FROM screenshots WHERE id = $1 AND device_id = $2', [id, dev.device_id])).rowCount) throw notFound;
      return done;
    });
  }

  // process-tamper-alerts/tamper-ingestion. Stored once on its ID, any age (D24).
  @Post('tamper')
  async tamper(@Req() req: FastifyRequest, @Headers('x-device-key') key: string | undefined, @Body() raw: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    return this.db.tx(async (c) => {
      const { dev, billing } = await authDevice(c, key, 'normal');
      tag(req, dev);
      if (billing) throw billing;
      const b = parse(tamperBody, raw, 422);
      const ins = await c.query(
        `INSERT INTO tamper_events (id, company_id, device_id, hostname, event_type, detail, occurred_at, repeat_count)
         SELECT $1, company_id, id, hostname, $3, $4, least($5::timestamptz, now()), $6 FROM devices WHERE id = $2
         ON CONFLICT DO NOTHING RETURNING id, received_at`,
        [b.id, dev.device_id, b.event_type, JSON.stringify(b.detail), b.occurred_at, b.repeat_count],
      );
      if (ins.rowCount) {
        res.status(201);
        return { data: ins.rows[0] };
      }
      const { rows: [t] } = await c.query('SELECT id, received_at, device_id, event_type FROM tamper_events WHERE id = $1', [b.id]);
      if (!t || t.device_id !== dev.device_id || t.event_type !== b.event_type)
        throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'Tamper event ID reused');
      res.status(200);
      return { data: { id: t.id, received_at: t.received_at } };
    });
  }
}
