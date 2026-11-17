// Usage reports, calendar, timesheet, CSV exports and the dashboard (report-usage).
// Days are company-timezone days: each transaction sets its TimeZone to companies.timezone, so
// date ↔ timestamptz casts and ::date use local midnight.
import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ADMIN_MANAGER, ALL, employeeFor, portalUser, scopeEmployeeIds, User } from '../auth';
import { ApiError, Db, Tx } from '../core';
import { textPdf } from '../pdf';
import { alerts, listDevices } from './devices.controller';

const BROWSERS = ['safari', 'google chrome', 'chrome', 'microsoft edge', 'msedge', 'firefox', 'brave browser', 'brave', 'arc', 'opera', 'chromium', 'vivaldi'];
const EXPORT_ROW_CAP = 100_000;
const APP_CAT = `coalesce((SELECT r.category FROM productivity_rules r WHERE r.match_type = 'app' AND lower(r.pattern) = lower(a.app_name) LIMIT 1), 'neutral')`;
const DOM_CAT = `coalesce((SELECT r.category FROM productivity_rules r WHERE r.match_type = 'domain'
  AND (lower(v.domain) = lower(r.pattern) OR lower(v.domain) LIKE '%.' || lower(r.pattern)) ORDER BY length(r.pattern) DESC LIMIT 1), 'neutral')`;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// A real calendar day (rejects 2026-02-30, which Date.parse rolls over).
export const isDay = (d?: string) => !!d && DATE.test(d) && !isNaN(Date.parse(d)) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;

type Range = { ids: string[]; from: string; to: string };
const bad = (field: string, msg: string) => new ApiError(422, 'VALIDATION_FAILED', msg, { fields: [field] });
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10);
const days = (from: string, to: string) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };
const pct = (act: number, tot: number) => (tot > 0 ? Math.round((act / tot) * 1000) / 10 : null);

// Company timezone for the transaction; returns the first retained day.
async function localTime(c: Tx) {
  const { rows: [co] } = await c.query('SELECT timezone, data_retention_days FROM companies');
  await c.query("SELECT set_config('timezone', $1, true)", [co.timezone]);
  const { rows: [r] } = await c.query("SELECT to_char(now()::date - $1::int + 1, 'YYYY-MM-DD') AS first, to_char(now()::date, 'YYYY-MM-DD') AS today", [co.data_retention_days]);
  return r as { first: string; today: string };
}

// Range + scope rules shared by every report and export (usage-reports).
async function reportRange(c: Tx, u: User, q: Record<string, string | undefined>): Promise<Range> {
  const { first } = await localTime(c);
  if (!isDay(q.from)) throw bad('from', 'from must be YYYY-MM-DD');
  if (!isDay(q.to)) throw bad('to', 'to must be YYYY-MM-DD');
  if (q.to! < q.from!) throw bad('to', 'to is before from');
  if (Date.parse(q.to!) - Date.parse(q.from!) > 365 * 86400_000) throw bad('to', 'range over 366 days');
  const scopes = ['employee_id', 'manager_user_id', 'department'].filter((k) => q[k]);
  if (scopes.length > 1) throw bad(scopes[1], 'at most one of employee_id, manager_user_id, department');
  if (q.manager_user_id && u.role === 'manager' && q.manager_user_id !== u.id) throw new ApiError(403, 'FORBIDDEN', 'Managers see only their own team');
  let ids: string[];
  if (q.employee_id) ids = [(await employeeFor(c, u, q.employee_id)).id];
  else {
    const { rows } = await c.query(
      `SELECT id FROM employees WHERE ($1 <> 'manager' OR manager_user_id = $2)
         AND ($3::text IS NULL OR manager_user_id::text = $3) AND ($4::text IS NULL OR department = $4)`,
      [u.role, u.id, q.manager_user_id ?? null, q.department ?? null],
    );
    ids = rows.map((r) => r.id);
  }
  return { ids, from: q.from! < first ? first : q.from!, to: q.to! };
}

// Per employee and day: tracked time, first/last activity, samples, productivity split.
async function daily(c: Tx, r: Range) {
  const p = [r.ids, r.from, r.to, BROWSERS];
  const { rows } = await c.query(
    `WITH s AS (SELECT a.employee_id, a.started_at::date AS day, a.duration_seconds, a.started_at, a.ended_at, ${APP_CAT} AS cat,
                       lower(a.app_name) = ANY ($4) AS browser
                  FROM app_sessions a WHERE a.employee_id = ANY ($1) AND a.started_at >= $2::date AND a.started_at < $3::date + 1),
          v AS (SELECT v.employee_id, v.visited_at::date AS day, v.duration_seconds, ${DOM_CAT} AS cat
                  FROM url_visits v WHERE v.employee_id = ANY ($1) AND v.visited_at >= $2::date AND v.visited_at < $3::date + 1),
          b AS (SELECT employee_id, bucket_start::date AS day, sum(active_samples) AS act, sum(total_samples) AS tot
                  FROM activity_buckets WHERE employee_id = ANY ($1) AND bucket_start >= $2::date AND bucket_start < $3::date + 1 GROUP BY 1, 2),
          t AS (SELECT employee_id, day, sum(duration_seconds) AS tracked, min(started_at) AS first_at, max(ended_at) AS last_at FROM s GROUP BY 1, 2),
          pr AS (SELECT employee_id, day, sum(duration_seconds) FILTER (WHERE cat = 'productive') AS productive,
                        sum(duration_seconds) FILTER (WHERE cat = 'neutral') AS neutral, sum(duration_seconds) FILTER (WHERE cat = 'unproductive') AS unproductive
                   FROM (SELECT employee_id, day, cat, duration_seconds FROM s WHERE NOT browser
                         UNION ALL SELECT employee_id, day, cat, duration_seconds FROM v) x GROUP BY 1, 2),
          k AS (SELECT employee_id, day FROM t UNION SELECT employee_id, day FROM b UNION SELECT employee_id, day FROM pr)
     SELECT k.employee_id, to_char(k.day, 'YYYY-MM-DD') AS date, coalesce(t.tracked, 0)::int AS tracked_seconds, t.first_at, t.last_at,
            coalesce(b.act, 0)::int AS act, coalesce(b.tot, 0)::int AS tot, coalesce(pr.productive, 0)::int AS productive_seconds,
            coalesce(pr.neutral, 0)::int AS neutral_seconds, coalesce(pr.unproductive, 0)::int AS unproductive_seconds
       FROM k LEFT JOIN t USING (employee_id, day) LEFT JOIN b USING (employee_id, day) LEFT JOIN pr USING (employee_id, day)`,
    p,
  );
  return rows;
}

// Days a non-cancelled pause of the employee overlaps.
async function pausedDays(c: Tx, employeeId: string, from: string, to: string) {
  const { rows } = await c.query(
    `SELECT DISTINCT to_char(g::date, 'YYYY-MM-DD') AS d FROM monitoring_pauses p,
            generate_series($2::date, $3::date, interval '1 day') g
      WHERE p.employee_id = $1 AND p.cancelled_at IS NULL AND p.starts_at < (g::date + 1)::timestamptz AND p.ends_at > g::date::timestamptz`,
    [employeeId, from, to],
  );
  return new Set(rows.map((r) => r.d));
}

function dayRows(rows: any[], dates: string[], paused: Set<string>) {
  return dates.map((date) => {
    const r = rows.filter((x) => x.date === date);
    const sum = (k: string) => r.reduce((a, x) => a + x[k], 0);
    const firsts = r.map((x) => x.first_at).filter(Boolean), lasts = r.map((x) => x.last_at).filter(Boolean);
    return {
      date, tracked_seconds: sum('tracked_seconds'), activity_percent: pct(sum('act'), sum('tot')),
      productive_seconds: sum('productive_seconds'), neutral_seconds: sum('neutral_seconds'), unproductive_seconds: sum('unproductive_seconds'),
      paused: paused.has(date),
      first_activity_at: firsts.length ? new Date(Math.min(...firsts.map(Number))) : null,
      last_activity_at: lasts.length ? new Date(Math.max(...lasts.map(Number))) : null,
    };
  });
}

// group_by=day|week|month (admin request 2.1): one row per period in the range, zeros included.
// Weeks start on Monday; a period is labelled by its first day, clipped to the range.
async function periods(c: Tx, r: Range, g: string | undefined) {
  if (g === undefined) return undefined;
  if (!['day', 'week', 'month'].includes(g)) throw bad('group_by', 'group_by must be day, week or month');
  const key = (d: string) => g === 'day' ? d : g === 'month' ? d.slice(0, 8) + '01'
    : addDays(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7));
  const rows = await daily(c, r);
  const out = new Map<string, any>();
  for (const d of days(r.from, r.to)) {
    const k = key(d);
    if (!out.has(k)) out.set(k, { period_start: k < r.from ? r.from : k, tracked_seconds: 0, act: 0, tot: 0, productive_seconds: 0, neutral_seconds: 0, unproductive_seconds: 0 });
    for (const x of rows.filter((x) => x.date === d)) {
      const o = out.get(k);
      for (const f of ['tracked_seconds', 'act', 'tot', 'productive_seconds', 'neutral_seconds', 'unproductive_seconds']) o[f] += x[f];
    }
  }
  return [...out.values()].map(({ act, tot, ...o }) => ({ ...o, activity_percent: pct(act, tot) }));
}

// CSV cell: neutralise spreadsheet formulas, quote when needed (data-export).
export function csvCell(v: unknown) {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

@Controller('v1')
export class ReportsController {
  constructor(@Inject(Db) private db: Db) {}

  @Get('reports/apps')
  async apps(@Req() req: FastifyRequest, @Query() q: Record<string, string>) {
    return this.ranked(req, q, 'apps');
  }

  @Get('reports/websites')
  async websites(@Req() req: FastifyRequest, @Query() q: Record<string, string>) {
    return this.ranked(req, q, 'websites');
  }

  private ranked(req: FastifyRequest, q: Record<string, string>, kind: 'apps' | 'websites') {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN_MANAGER);
      const r = await reportRange(c, u, q);
      const limit = q.limit === undefined ? 10 : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw bad('limit', 'limit must be 1–100');
      const sql = kind === 'apps'
        ? `SELECT a.app_name, sum(a.duration_seconds)::int AS seconds, ${APP_CAT} AS category FROM app_sessions a
            WHERE a.employee_id = ANY ($1) AND a.started_at >= $2::date AND a.started_at < $3::date + 1 GROUP BY a.app_name ORDER BY seconds DESC LIMIT $4`
        : `SELECT v.domain, sum(v.duration_seconds)::int AS seconds, ${DOM_CAT} AS category FROM url_visits v
            WHERE v.employee_id = ANY ($1) AND v.visited_at >= $2::date AND v.visited_at < $3::date + 1 GROUP BY v.domain ORDER BY seconds DESC LIMIT $4`;
      const { rows } = await c.query(sql, [r.ids, r.from, r.to, limit]);
      return { data: { from: r.from, to: r.to, [kind]: rows } };
    });
  }

  @Get('reports/activity')
  async activity(@Req() req: FastifyRequest, @Query() q: Record<string, string>) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN_MANAGER);
      const r = await reportRange(c, u, q);
      const p = [r.ids, r.from, r.to];
      const { rows: [tot] } = await c.query(
        `SELECT (SELECT coalesce(sum(duration_seconds), 0)::int FROM app_sessions WHERE employee_id = ANY ($1) AND started_at >= $2::date AND started_at < $3::date + 1) AS tracked,
                (SELECT coalesce(sum(extract(epoch FROM ended_at - started_at)), 0)::int FROM idle_intervals WHERE employee_id = ANY ($1) AND started_at >= $2::date AND started_at < $3::date + 1) AS idle,
                (SELECT coalesce(sum(active_samples), 0)::int FROM activity_buckets WHERE employee_id = ANY ($1) AND bucket_start >= $2::date AND bucket_start < $3::date + 1) AS act,
                (SELECT coalesce(sum(total_samples), 0)::int FROM activity_buckets WHERE employee_id = ANY ($1) AND bucket_start >= $2::date AND bucket_start < $3::date + 1) AS tot`,
        p,
      );
      const { rows: th } = await c.query(
        `SELECT extract(hour FROM started_at)::int AS h, (sum(duration_seconds)::float / count(DISTINCT started_at::date))::int AS avg
           FROM app_sessions WHERE employee_id = ANY ($1) AND started_at >= $2::date AND started_at < $3::date + 1 GROUP BY 1`, p);
      const { rows: bh } = await c.query(
        `SELECT extract(hour FROM bucket_start)::int AS h, sum(active_samples)::int AS act, sum(total_samples)::int AS tot
           FROM activity_buckets WHERE employee_id = ANY ($1) AND bucket_start >= $2::date AND bucket_start < $3::date + 1 GROUP BY 1`, p);
      const hours = Array.from({ length: 24 }, (_, h) => {
        const b = bh.find((x) => x.h === h);
        return { hour: h, tracked_seconds: th.find((x) => x.h === h)?.avg ?? 0, activity_percent: b ? pct(b.act, b.tot) : null };
      });
      return { data: { from: r.from, to: r.to, tracked_seconds: tot.tracked, activity_percent: pct(tot.act, tot.tot), idle_seconds: tot.idle, hours,
        periods: await periods(c, r, q.group_by) } };
    });
  }

  @Get('reports/productivity')
  async productivity(@Req() req: FastifyRequest, @Query() q: Record<string, string>) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN_MANAGER);
      const r = await reportRange(c, u, q);
      const rows = await daily(c, r);
      const sum = (k: string) => rows.reduce((a, x) => a + x[k], 0);
      return { data: { from: r.from, to: r.to, productive_seconds: sum('productive_seconds'), neutral_seconds: sum('neutral_seconds'),
        unproductive_seconds: sum('unproductive_seconds'), tracked_seconds: sum('tracked_seconds'), periods: await periods(c, r, q.group_by) } };
    });
  }

  @Get('employees/:id/calendar')
  async calendar(@Req() req: FastifyRequest, @Param('id') id: string, @Query('view') view: string, @Query('date') date: string) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN_MANAGER);
      const e = await employeeFor(c, u, id);
      const { first } = await localTime(c);
      if (!['day', 'week', 'month'].includes(view)) throw bad('view', 'view must be day, week or month');
      if (!isDay(date)) throw bad('date', 'date must be YYYY-MM-DD');
      let from = date, to = date;
      if (view === 'week') { from = addDays(date, -((new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7)); to = addDays(from, 6); }
      if (view === 'month') { from = date.slice(0, 8) + '01'; to = addDays(addDays(from, 31).slice(0, 8) + '01', -1); }
      const dates = days(from < first ? first : from, to).filter((d) => d >= first);
      if (!dates.length) return { data: [] };
      const rows = await daily(c, { ids: [e.id], from: dates[0], to });
      const paused = await pausedDays(c, e.id, dates[0], to);
      return { data: dayRows(rows, dates, paused).map(({ first_activity_at, last_activity_at, ...d }) => d) };
    });
  }

  @Get('employees/:id/timesheet')
  async timesheet(@Req() req: FastifyRequest, @Param('id') id: string, @Query('week') week: string) {
    const { timezone: _tz, ...data } = await this.sheet(req, id, week);
    return { data };
  }

  private async sheet(req: FastifyRequest, id: string, week: string) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN_MANAGER);
      const e = await employeeFor(c, u, id);
      await localTime(c);
      if (!isDay(week) || new Date(week + 'T00:00:00Z').getUTCDay() !== 1) throw bad('week', 'week must be a Monday, YYYY-MM-DD');
      const to = addDays(week, 6);
      const rows = dayRows(await daily(c, { ids: [e.id], from: week, to }), days(week, to), await pausedDays(c, e.id, week, to));
      const { rows: [co] } = await c.query('SELECT name, timezone FROM companies');
      const sum = (k: keyof (typeof rows)[0]) => rows.reduce((a, x) => a + (x[k] as number), 0);
      const act = await c.query(
        'SELECT coalesce(sum(active_samples), 0)::int AS a, coalesce(sum(total_samples), 0)::int AS t FROM activity_buckets WHERE employee_id = $1 AND bucket_start >= $2::date AND bucket_start < $3::date + 1',
        [e.id, week, to]);
      return {
        timezone: co.timezone as string, // for the PDF's clock times only
        employee: { name: e.name, email: e.email }, company: { name: co.name }, week, days: rows,
        totals: { tracked_seconds: sum('tracked_seconds'), activity_percent: pct(act.rows[0].a, act.rows[0].t), productive_seconds: sum('productive_seconds'),
          neutral_seconds: sum('neutral_seconds'), unproductive_seconds: sum('unproductive_seconds') },
      };
    });
  }

  // The JSON timesheet as a one-page PDF, built per request, never stored.
  @Get('employees/:id/timesheet.pdf')
  async timesheetPdf(@Req() req: FastifyRequest, @Param('id') id: string, @Query('week') week: string, @Res() res: FastifyReply) {
    const t = await this.sheet(req, id, week);
    const hm = (s: number) => `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
    const clock = (v: Date | null) => (v ? new Date(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: t.timezone }) : '-');
    const pctTxt = (p: number | null) => (p === null ? '-' : `${p}%`);
    const cols = [50, 130, 185, 240, 310, 370, 440, 510];
    const row = (cells: string[], bold = false) => cells.map((text, i) => ({ text, x: cols[i], bold, gap: i ? 0 : 18 }));
    const pdf = textPdf([
      { text: `Timesheet - ${t.employee.name}`, size: 16, bold: true, gap: 0 },
      { text: `${t.company.name} · week of ${t.week} · ${t.employee.email ?? ''}`, gap: 22 },
      ...row(['Date', 'First', 'Last', 'Tracked', 'Activity', 'Productive', 'Neutral', 'Unprod.'], true),
      ...t.days.flatMap((d: any) => row([d.date + (d.paused ? ' *' : ''), clock(d.first_activity_at), clock(d.last_activity_at), hm(d.tracked_seconds),
        pctTxt(d.activity_percent), hm(d.productive_seconds), hm(d.neutral_seconds), hm(d.unproductive_seconds)])),
      ...row(['Total', '', '', hm(t.totals.tracked_seconds), pctTxt(t.totals.activity_percent), hm(t.totals.productive_seconds),
        hm(t.totals.neutral_seconds), hm(t.totals.unproductive_seconds)], true),
      { text: `* monitoring was paused on that day. Times in ${t.timezone}.`, size: 8, gap: 28 },
    ]);
    const name = `timesheet-${t.employee.name.replace(/[^\w.-]+/g, '-')}-${t.week}.pdf`;
    return res.status(200).type('application/pdf').header('Content-Disposition', `attachment; filename="${name}"`).send(pdf);
  }

  // ------------------------------------------------------------ exports

  @Get('exports/:kind')
  async export(@Req() req: FastifyRequest, @Param('kind') kind: string, @Query() q: Record<string, string>, @Res() res: FastifyReply) {
    const csv = await this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN_MANAGER);
      const r = await reportRange(c, u, q);
      const p = [r.ids, r.from, r.to, EXPORT_ROW_CAP + 1];
      const ts = (col: string) => `to_char(${col}, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS ${col.split('.').pop()}`;
      let header: string[], rows: any[];
      if (kind === 'app-sessions.csv') {
        header = ['employee_name', 'employee_email', 'category', 'app_name', 'bundle_id', 'process_name', 'window_title', 'started_at', 'ended_at', 'duration_seconds'];
        rows = (await c.query(`SELECT e.name AS employee_name, e.email AS employee_email, ${APP_CAT} AS category, a.app_name, a.bundle_id, a.process_name,
            a.window_title, ${ts('a.started_at')}, ${ts('a.ended_at')}, a.duration_seconds
          FROM app_sessions a JOIN employees e ON e.id = a.employee_id
          WHERE a.employee_id = ANY ($1) AND a.started_at >= $2::date AND a.started_at < $3::date + 1 ORDER BY a.started_at LIMIT $4`, p)).rows;
      } else if (kind === 'url-visits.csv') {
        header = ['employee_name', 'employee_email', 'category', 'browser', 'url', 'domain', 'visited_at', 'duration_seconds'];
        rows = (await c.query(`SELECT e.name AS employee_name, e.email AS employee_email, ${DOM_CAT} AS category, v.browser, v.url, v.domain,
            ${ts('v.visited_at')}, v.duration_seconds
          FROM url_visits v JOIN employees e ON e.id = v.employee_id
          WHERE v.employee_id = ANY ($1) AND v.visited_at >= $2::date AND v.visited_at < $3::date + 1 ORDER BY v.visited_at LIMIT $4`, p)).rows;
      } else if (kind === 'daily-summaries.csv') {
        header = ['employee_name', 'employee_email', 'date', 'tracked_seconds', 'activity_percent', 'productive_seconds', 'neutral_seconds', 'unproductive_seconds'];
        const { rows: emps } = await c.query('SELECT id, name, email FROM employees WHERE id = ANY ($1)', [r.ids]);
        const names = new Map(emps.map((x) => [x.id, x]));
        rows = (await daily(c, r)).sort((a, b) => a.date.localeCompare(b.date)).map((x) => ({
          employee_name: names.get(x.employee_id)?.name, employee_email: names.get(x.employee_id)?.email, date: x.date,
          tracked_seconds: x.tracked_seconds, activity_percent: pct(x.act, x.tot), productive_seconds: x.productive_seconds,
          neutral_seconds: x.neutral_seconds, unproductive_seconds: x.unproductive_seconds,
        }));
      } else throw new ApiError(404, 'NOT_FOUND', 'Not found');
      if (rows.length > EXPORT_ROW_CAP) throw new ApiError(422, 'EXPORT_TOO_LARGE', 'Too many rows; narrow the range', { cap: EXPORT_ROW_CAP });
      return [header.join(','), ...rows.map((row) => header.map((h) => csvCell(row[h])).join(','))].join('\r\n') + '\r\n';
    });
    const name = `workbeat-${kind.replace('.csv', '')}-${q.from}-${q.to}.csv`;
    return res.status(200).type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${name}"`).send(csv);
  }

  // ------------------------------------------------------------ dashboard

  @Get('dashboard')
  async dashboard(@Req() req: FastifyRequest) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ALL);
      const devs = (await listDevices(c, "($1 <> 'manager' OR e.manager_user_id = $2)", [u.role, u.id]))
        .filter((d) => d.status !== 'released' && d.status !== 'deactivated');
      const count = (s: string) => devs.filter((d) => d.status === s).length;
      const data: Record<string, unknown> = {
        devices: { online: count('online'), offline: count('offline'), tamper: count('tamper') },
        alerts: (await alerts(c, u, {}, 5)).items,
      };
      if (u.role !== 'it_admin') {
        const { today } = await localTime(c);
        const rows = await daily(c, { ids: await scopeEmployeeIds(c, u), from: today, to: today });
        const sum = (k: string) => rows.reduce((a, x) => a + x[k], 0);
        data.today = { tracked_seconds: sum('tracked_seconds'), activity_percent: pct(sum('act'), sum('tot')) };
      }
      if (u.role === 'company_admin') {
        const { rows: [s] } = await c.query('SELECT seat_limit, (SELECT count(*)::int FROM devices WHERE deactivated_at IS NULL AND released_at IS NULL) AS used FROM licenses');
        data.seats = { used: s.used, limit: s.seat_limit };
      }
      return { data };
    });
  }
}
