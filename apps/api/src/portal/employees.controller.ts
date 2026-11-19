// Employee directory, CSV import, monitoring settings, pauses, notice evidence, screenshots (manage-employees).
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ADMIN, ADMIN_MANAGER, ALL, employeeFor, idOrNone, portalUser, User } from '../auth';
import { ApiError, Db, parse, Tx } from '../core';
import { baseUrl } from '../http';
import { Storage, thumbPath } from '../storage';
import { isDay, localTime, MAX_RANGE_DAYS } from './reports.controller';
import { listDevices } from './devices.controller';

// Fallback for agents that do not report input: a 10-minute bucket is closed by the next sample and
// sent with the next 10-minute sync, so a working employee's newest one can be ~31 minutes old.
const BUCKET_LOOKBACK_MINUTES = 35;
// presence (employee-directory): paused > no_device > tamper > offline (no live device online) >
// active (an online device is active) > idle. A live binding is a device neither released nor
// deactivated. A device is active when its latest heartbeat reported input within the idle threshold,
// or, when it reported none (last_input_at NULL), when one of its own recent buckets has active samples.
async function withPresence(c: Tx, rows: any[]) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const { rows: st } = await c.query(
    `SELECT e.id, EXISTS (SELECT 1 FROM monitoring_pauses p WHERE p.employee_id = e.id AND p.cancelled_at IS NULL
                           AND p.starts_at <= now() AND p.ends_at > now()) AS paused
       FROM employees e WHERE e.id = ANY ($1)`,
    [ids],
  );
  const { rows: act } = await c.query(
    `SELECT d.id FROM devices d JOIN companies co ON co.id = d.company_id
      WHERE d.employee_id = ANY ($1) AND d.released_at IS NULL
        AND CASE WHEN d.last_input_at IS NOT NULL
                 THEN d.last_input_at >= d.last_heartbeat_at - make_interval(secs => co.idle_threshold_seconds)
                 ELSE EXISTS (SELECT 1 FROM activity_buckets b WHERE b.company_id = d.company_id AND b.device_id = d.id
                               AND b.bucket_start > now() - make_interval(mins => $2) AND b.active_samples > 0) END`,
    [ids, BUCKET_LOOKBACK_MINUTES],
  );
  const active = new Set(act.map((a) => a.id));
  const devs = await listDevices(c, 'd.employee_id = ANY ($1) AND d.released_at IS NULL', [ids]);
  return rows.map((r) => {
    const s = st.find((x) => x.id === r.id);
    const mine = devs.filter((d) => d.employee.id === r.id);
    const live = mine.filter((d) => d.status !== 'deactivated');
    const online = live.filter((d) => d.status === 'online');
    const presence = s?.paused ? 'paused' : !live.length ? 'no_device' : live.some((d) => d.status === 'tamper') ? 'tamper'
      : !online.length ? 'offline' : online.some((d) => active.has(d.id)) ? 'active' : 'idle';
    return { ...r, presence, devices: mine.map((d) => ({ id: d.id, hostname: d.hostname, os: d.os, status: d.status, last_heartbeat_at: d.last_heartbeat_at })) };
  });
}

const FULL = 'id, name, email, department, manager_user_id, archived_at';
const IMPORT_MAX_ROWS = 5000;
const SCREENSHOT_VIEW_SECONDS = 5 * 60;
// Tiles load the thumbnail when the agent sent one, else the full JPEG, so pages stay small.
const SCREENSHOT_PAGE = 24, SCREENSHOT_PAGE_MAX = 60;
const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const employeeBody = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(254), // required: identifies the person and dedupes imports
  department: optText(200),
  manager_user_id: z.string().uuid().nullish(),
});
const settingsBody = z.object({
  activity: z.boolean(), app_usage: z.boolean(), window_titles: z.boolean(), website_visits: z.boolean(),
  screenshot_interval_seconds: z.union([z.literal(0), z.literal(600), z.literal(1800), z.literal(3600)]),
});
const REASONS = ['annual_leave', 'sick_leave', 'personal', 'offsite_training', 'other'] as const;
const PAUSE = `id, starts_at, ends_at, reason, note, created_by, (SELECT name FROM users u WHERE u.id = created_by) AS created_by_name, cancelled_at,
  CASE WHEN cancelled_at IS NOT NULL THEN 'cancelled' WHEN ends_at <= now() THEN 'ended'
       WHEN starts_at <= now() THEN 'active' ELSE 'scheduled' END AS status`;

async function assertManager(c: Tx, id: string | null | undefined) {
  if (!id) return;
  const r = await c.query("SELECT 1 FROM users WHERE id = $1 AND role = 'manager' AND disabled_at IS NULL", [id]);
  if (!r.rowCount) throw new ApiError(422, 'VALIDATION_FAILED', 'manager_user_id is not an enabled manager', { fields: ['manager_user_id'] });
}
function assertActive(e: { archived_at: Date | null }) {
  if (e.archived_at) throw new ApiError(409, 'CONFLICT', 'Employee is archived');
}

// Minimal RFC 4180 reader: quoted fields, "" escapes, CRLF or LF.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim()));
}

@Controller('v1/employees')
export class EmployeesController {
  constructor(@Inject(Db) private db: Db, @Inject(Storage) private storage: Storage) {}

  @Get()
  async list(@Req() req: FastifyRequest, @Query('archived') archived?: string, @Query('manager_user_id') managerId?: string) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ALL);
      const { rows } = await c.query(
        `SELECT ${FULL} FROM employees
          WHERE ($1 OR archived_at IS NULL) AND ($2 <> 'manager' OR manager_user_id = $3)
            AND ($4::uuid IS NULL OR manager_user_id = $4) ORDER BY name, id`,
        [archived === 'true', u.role, u.id, managerId ? idOrNone(managerId) : null],
      );
      return { data: await withPresence(c, rows) };
    });
  }

  @Post()
  async create(@Req() req: FastifyRequest, @Body() raw: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN);
      const b = parse(employeeBody, raw);
      await assertManager(c, b.manager_user_id);
      const { rows: [e] } = await c.query( // employees_email unique → 409
        `INSERT INTO employees (company_id, name, email, department, manager_user_id) VALUES ($1, $2, $3, $4, $5) RETURNING ${FULL}`,
        [u.company_id, b.name, b.email ?? null, b.department, b.manager_user_id ?? null],
      );
      res.status(201);
      return { data: e };
    });
  }

  @Post('import')
  async import(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN);
      if (typeof req.body !== 'string') throw new ApiError(400, 'VALIDATION_FAILED', 'Send the CSV as text/csv', { fields: ['content-type'] });
      let rows = parseCsv(req.body);
      if (rows[0]?.[0]?.trim().toLowerCase() === 'name') rows = rows.slice(1);
      if (rows.length > IMPORT_MAX_ROWS) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `At most ${IMPORT_MAX_ROWS} rows`);
      const { rows: managers } = await c.query("SELECT id, lower(email) AS email FROM users WHERE role = 'manager' AND disabled_at IS NULL");
      const { rows: existing } = await c.query('SELECT lower(email) AS email FROM employees WHERE archived_at IS NULL AND email IS NOT NULL');
      const taken = new Set(existing.map((r) => r.email));
      // A returning employee is restored, not created again (D46): an email only an archived employee holds is refused.
      const { rows: gone } = await c.query(
        'SELECT DISTINCT ON (lower(email)) id, name, lower(email) AS email FROM employees WHERE archived_at IS NOT NULL AND email IS NOT NULL ORDER BY lower(email), archived_at DESC',
      );
      const archivedBy = new Map(gone.map((r) => [r.email, r]));
      const seen = new Set<string>(), bad: number[] = [], create: any[] = [], skipped: string[] = [];
      const archived: { line: number; employee_id: string; name: string }[] = [];
      rows.forEach((r, i) => {
        const [name = '', mail = '', dept = '', mgr = ''] = r.map((v) => v.trim());
        const email = mail.toLowerCase();
        const manager = mgr ? managers.find((m) => m.email === mgr.toLowerCase()) : null;
        const old = taken.has(email) ? undefined : archivedBy.get(email);
        if (old) archived.push({ line: i + 1, employee_id: old.id, name: old.name });
        if (!name || !z.string().email().safeParse(email).success || (mgr && !manager) || (email && seen.has(email)) || old) bad.push(i + 1);
        seen.add(email);
        if (taken.has(email)) skipped.push(email);
        else create.push({ name, email, department: dept || null, manager_user_id: manager?.id ?? null });
      });
      if (bad.length) throw new ApiError(422, 'VALIDATION_FAILED', 'Invalid rows', archived.length ? { lines: bad, archived } : { lines: bad });
      if (create.length)
        await c.query(
          `INSERT INTO employees (company_id, name, email, department, manager_user_id)
           SELECT $1, x.name, x.email, x.department, x.manager_user_id
             FROM jsonb_to_recordset($2) AS x(name text, email text, department text, manager_user_id uuid)`,
          [u.company_id, JSON.stringify(create)],
        );
      res.status(201);
      return { data: { created: create.length, skipped: skipped.length, skipped_emails: skipped } };
    });
  }

  @Get(':id')
  async get(@Req() req: FastifyRequest, @Param('id') id: string) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ALL);
      const e = await employeeFor(c, u, id);
      return { data: (await withPresence(c, [e]))[0] };
    });
  }

  @Patch(':id')
  async patch(@Req() req: FastifyRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN);
      const e = await employeeFor(c, u, id);
      assertActive(e);
      const b = parse(employeeBody.partial(), raw);
      await assertManager(c, b.manager_user_id);
      const { rows: [r] } = await c.query(
        `UPDATE employees SET name = coalesce($2, name),
                email = CASE WHEN $3 THEN $4 ELSE email END, department = CASE WHEN $5 THEN $6 ELSE department END,
                manager_user_id = CASE WHEN $7 THEN $8::uuid ELSE manager_user_id END
          WHERE id = $1 RETURNING ${FULL}`,
        [e.id, b.name ?? null, 'email' in b, b.email ?? null, 'department' in b, b.department ?? null, 'manager_user_id' in b, b.manager_user_id ?? null],
      );
      return { data: r };
    });
  }

  @Delete(':id')
  async archive(@Req() req: FastifyRequest, @Param('id') id: string, @Res({ passthrough: true }) res: FastifyReply) {
    await this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN);
      const e = await employeeFor(c, u, id);
      await c.query('UPDATE employees SET archived_at = coalesce(archived_at, now()) WHERE id = $1', [e.id]); // trigger → 409 EMPLOYEE_HAS_DEVICES
    });
    res.status(204);
  }

  // A returning employee is restored, not created again (D46). Takes no seat: their computer enrolls again as a new binding.
  @Post(':id/restore')
  async restore(@Req() req: FastifyRequest, @Param('id') id: string, @Body() raw: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN);
      const e = await employeeFor(c, u, id);
      const b = parse(z.object({ email: employeeBody.shape.email.optional() }), raw ?? {});
      res.status(200);
      if (!e.archived_at) return { data: (await withPresence(c, [e]))[0] };
      const email = b.email ?? e.email;
      if (!email) throw new ApiError(422, 'VALIDATION_FAILED', 'The employee has no email; send one', { fields: ['email'] });
      const { rows: [r] } = await c.query( // employees_email unique → 409 CONFLICT
        `UPDATE employees SET archived_at = NULL, email = $2 WHERE id = $1 RETURNING ${FULL}`,
        [e.id, email],
      );
      return { data: (await withPresence(c, [r]))[0] };
    });
  }

  @Get(':id/notice-acknowledgements')
  async acks(@Req() req: FastifyRequest, @Param('id') id: string) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN);
      const e = await employeeFor(c, u, id);
      const { rows } = await c.query(
        `SELECT a.device_id, d.hostname, a.notice_version, a.acknowledged_at, a.received_at
           FROM notice_acknowledgements a JOIN devices d ON d.id = a.device_id
          WHERE a.employee_id = $1 ORDER BY a.received_at DESC`,
        [e.id],
      );
      return { data: rows };
    });
  }

  // ------------------------------------------------------------ monitoring settings

  @Get(':id/monitoring-settings')
  async getSettings(@Req() req: FastifyRequest, @Param('id') id: string) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ALL);
      const e = await employeeFor(c, u, id);
      // screenshot_tier: the console offers only intervals the plan allows, without reading billing (staff-managed).
      const { rows: [s] } = await c.query(
        `SELECT activity, app_usage, window_titles, website_visits, screenshot_interval_seconds,
                (SELECT screenshot_tier FROM licenses) AS screenshot_tier
           FROM employee_monitoring_settings WHERE employee_id = $1`,
        [e.id],
      );
      return { data: s };
    });
  }

  @Put(':id/monitoring-settings')
  async putSettings(@Req() req: FastifyRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN);
      const e = await employeeFor(c, u, id);
      assertActive(e);
      const b = parse(settingsBody, raw);
      const { rows: [l] } = await c.query('SELECT tier_interval(screenshot_tier) AS min FROM licenses');
      const iv = b.screenshot_interval_seconds;
      if (iv !== 0 && (l.min === 0 || iv < l.min))
        throw new ApiError(422, 'VALIDATION_FAILED', 'Screenshot interval not allowed by the tier', { fields: ['screenshot_interval_seconds'] });
      const { rows: [s] } = await c.query(
        `UPDATE employee_monitoring_settings SET activity = $2, app_usage = $3, window_titles = $4, website_visits = $5,
                screenshot_interval_seconds = $6, updated_by = $7
          WHERE employee_id = $1 RETURNING activity, app_usage, window_titles, website_visits, screenshot_interval_seconds`,
        [e.id, b.activity, b.app_usage, b.window_titles, b.website_visits, iv, u.id],
      );
      return { data: s };
    });
  }

  // ------------------------------------------------------------ pauses

  @Get(':id/pauses')
  async pauses(@Req() req: FastifyRequest, @Param('id') id: string) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ALL);
      const e = await employeeFor(c, u, id);
      return { data: (await c.query(`SELECT ${PAUSE} FROM monitoring_pauses WHERE employee_id = $1 ORDER BY starts_at DESC`, [e.id])).rows };
    });
  }

  @Post(':id/pauses')
  async addPause(@Req() req: FastifyRequest, @Param('id') id: string, @Body() raw: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN);
      const e = await employeeFor(c, u, id);
      assertActive(e);
      const b = parse(z.object({
        starts_at: z.string().datetime({ offset: true }).optional(),
        ends_at: z.string().datetime({ offset: true }),
        reason: z.enum(REASONS),
        note: optText(500),
      }), raw);
      const now = Date.now();
      const start = b.starts_at ? new Date(b.starts_at) : new Date(now);
      if (start.getTime() < now - 60_000) throw new ApiError(422, 'VALIDATION_FAILED', 'starts_at is in the past', { fields: ['starts_at'] });
      if (new Date(b.ends_at) <= start) throw new ApiError(422, 'VALIDATION_FAILED', 'ends_at must be after starts_at', { fields: ['ends_at'] });
      const { rows: [p] } = await c.query( // overlap → exclusion constraint → 409
        `INSERT INTO monitoring_pauses (company_id, employee_id, starts_at, ends_at, reason, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${PAUSE}`,
        [u.company_id, e.id, start, b.ends_at, b.reason, b.note, u.id],
      );
      res.status(201);
      return { data: p };
    });
  }

  @Patch(':id/pauses/:pause_id')
  async patchPause(@Req() req: FastifyRequest, @Param('id') id: string, @Param('pause_id') pauseId: string, @Body() raw: unknown) {
    return this.db.tx(async (c) => {
      const { e, p } = await this.pauseFor(c, req, id, pauseId);
      assertActive(e);
      const b = parse(z.object({ ends_at: z.string().datetime({ offset: true }) }), raw);
      const end = new Date(b.ends_at);
      if (end <= p.starts_at || end.getTime() <= Date.now()) throw new ApiError(422, 'VALIDATION_FAILED', 'ends_at must be after starts_at and now', { fields: ['ends_at'] });
      const { rows: [r] } = await c.query(`UPDATE monitoring_pauses SET ends_at = $2 WHERE id = $1 RETURNING ${PAUSE}`, [p.id, end]);
      return { data: r };
    });
  }

  @Post(':id/pauses/:pause_id/cancel')
  async cancelPause(@Req() req: FastifyRequest, @Param('id') id: string, @Param('pause_id') pauseId: string, @Res({ passthrough: true }) res: FastifyReply) {
    return this.db.tx(async (c) => {
      const { e, p, u } = await this.pauseFor(c, req, id, pauseId);
      assertActive(e);
      const { rows: [r] } = await c.query(`UPDATE monitoring_pauses SET cancelled_at = now(), cancelled_by = $2 WHERE id = $1 RETURNING ${PAUSE}`, [p.id, u.id]);
      res.status(200);
      return { data: r };
    });
  }

  private async pauseFor(c: Tx, req: FastifyRequest, id: string, pauseId: string) {
    const u = await portalUser(c, req, ADMIN);
    const e = await employeeFor(c, u, id);
    const { rows: [p] } = await c.query('SELECT id, starts_at, ends_at, cancelled_at FROM monitoring_pauses WHERE id = $1 AND employee_id = $2 FOR UPDATE', [idOrNone(pauseId), e.id]);
    if (!p) throw new ApiError(404, 'NOT_FOUND', 'Pause not found');
    if (p.cancelled_at || p.ends_at <= new Date()) throw new ApiError(409, 'CONFLICT', 'Pause is cancelled or ended');
    return { u, e, p };
  }

  // ------------------------------------------------------------ screenshots

  // screenshot-access: a range of company days, newest first, in pages (cursor = captured_at|id of the last item).
  @Get(':id/screenshots')
  async screenshots(@Req() req: FastifyRequest, @Param('id') id: string, @Query() q: Record<string, string | undefined>) {
    return this.db.tx(async (c) => {
      const u: User = await portalUser(c, req, ADMIN_MANAGER);
      const e = await employeeFor(c, u, id);
      const bad = (field: string, msg: string) => new ApiError(422, 'VALIDATION_FAILED', msg, { fields: [field] });
      const from = q.from ?? q.date, to = q.to ?? q.date;
      if (!isDay(from)) throw bad(q.from === undefined && q.date !== undefined ? 'date' : 'from', 'from must be YYYY-MM-DD');
      if (!isDay(to)) throw bad(q.to === undefined && q.date !== undefined ? 'date' : 'to', 'to must be YYYY-MM-DD');
      if (to! < from!) throw bad('to', 'to is before from');
      if (Date.parse(to!) - Date.parse(from!) > (MAX_RANGE_DAYS - 1) * 86400_000) throw bad('to', `range over ${MAX_RANGE_DAYS} days`);
      const limit = q.limit === undefined ? SCREENSHOT_PAGE : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > SCREENSHOT_PAGE_MAX) throw bad('limit', `limit must be 1–${SCREENSHOT_PAGE_MAX}`);
      let curAt: string | null = null, curId: string | null = null;
      if (q.cursor) {
        [curAt, curId] = Buffer.from(q.cursor, 'base64url').toString().split('|');
        if (!curAt || isNaN(Date.parse(curAt)) || idOrNone(curId ?? '') !== curId) throw bad('cursor', 'cursor is not valid');
      }
      const { first } = await localTime(c); // sets the transaction TimeZone to the company's
      const range = { from: from! < first ? first : from!, to: to! };
      const { rows: [l] } = await c.query('SELECT screenshot_tier FROM licenses');
      if (l.screenshot_tier === 'off') return { data: { screenshots_enabled: false, ...range, total: 0, items: [], next_cursor: null } };
      const where = `s.employee_id = $1 AND s.status = 'uploaded' AND s.captured_at >= $2::date AND s.captured_at < $3::date + 1`;
      const { rows: [{ total }] } = await c.query(`SELECT count(*)::int AS total FROM screenshots s WHERE ${where}`, [e.id, range.from, range.to]);
      const { rows } = await c.query(
        `SELECT s.id, s.captured_at, s.device_id, d.hostname, s.storage_path, s.thumb_bytes,
                to_char(s.captured_at, 'YYYY-MM-DD-HH24MI') AS local_time,
                to_char(s.captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
           FROM screenshots s JOIN devices d ON d.id = s.device_id
          WHERE ${where} AND ($4::timestamptz IS NULL OR (s.captured_at, s.id) < ($4, $5::uuid))
          ORDER BY s.captured_at DESC, s.id DESC LIMIT $6`,
        [e.id, range.from, range.to, curAt, curId, limit + 1],
      );
      const page = rows.slice(0, limit), last = page[page.length - 1];
      const next_cursor = rows.length > limit && last ? Buffer.from(`${last.cursor_at}|${last.id}`).toString('base64url') : null;
      const exp = Math.floor(Date.now() / 1000) + SCREENSHOT_VIEW_SECONDS;
      const sign = (path: string, download?: string) => this.storage.sign(baseUrl(req), 'GET', 'screenshots', path, exp, download);
      return { data: { screenshots_enabled: true, ...range, total, next_cursor, items: page.map(({ storage_path, thumb_bytes, local_time, cursor_at, ...r }) => ({
        ...r, view_url: sign(storage_path), thumb_url: thumb_bytes ? sign(thumbPath(storage_path)) : null,
        download_url: sign(storage_path, `${r.hostname.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 150) || 'screenshot'}-${local_time}.jpg`),
        expires_at: new Date(exp * 1000),
      })) } };
    });
  }
}
