// Usage reports, calendar, timesheet, CSV exports and the dashboard (report-usage).
// Days are company-timezone days: each transaction sets its TimeZone to companies.timezone, so
// date ↔ timestamptz casts and ::date use local midnight.
import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ALL, can, employeeFor, portalUser, scopeEmployeeIds, User } from '../auth';
import { ApiError, Db, Tx } from '../core';
import { textPdf } from '../pdf';
import { sessionHours } from '../usage';
import { alerts, OFFLINE_MINUTES } from './devices.controller';

const BROWSERS = ['safari', 'google chrome', 'chrome', 'microsoft edge', 'msedge', 'firefox', 'brave browser', 'brave', 'arc', 'opera', 'chromium', 'vivaldi'];
const EXPORT_ROW_CAP = 100_000;
// A range is at most 90 days, the longest retention (B13); `to` at most 89 days after `from`.
export const MAX_RANGE_DAYS = 90;
export const PDF_MAX_DAYS = 31;
const CATEGORIES = ['productive', 'neutral', 'unproductive'];
// Category of an app name or domain from the rules, at read time (never stored, PRD).
// Every query here names company_id itself: the RLS predicate (with its OR) is never an index condition.
const appCat = (col: string) => `coalesce((SELECT r.category FROM productivity_rules r WHERE r.company_id = app_company_id() AND r.match_type = 'app' AND lower(r.pattern) = lower(${col}) LIMIT 1), 'neutral')`;
const domCat = (col: string) => `coalesce((SELECT r.category FROM productivity_rules r WHERE r.company_id = app_company_id() AND r.match_type = 'domain'
  AND (lower(${col}) = lower(r.pattern) OR lower(${col}) LIKE '%.' || lower(r.pattern)) ORDER BY length(r.pattern) DESC LIMIT 1), 'neutral')`;
const APP_CAT = appCat('a.app_name');
const DOM_CAT = domCat('v.domain');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// A real calendar day (rejects 2026-02-30, which Date.parse rolls over).
export const isDay = (d?: string) => !!d && DATE.test(d) && !isNaN(Date.parse(d)) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;

type Range = { ids: string[]; from: string; to: string };
const bad = (field: string, msg: string) => new ApiError(422, 'VALIDATION_FAILED', msg, { fields: [field] });
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10);
const days = (from: string, to: string) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };
const pct = (act: number, tot: number) => (tot > 0 ? Math.round((act / tot) * 1000) / 10 : null);

// Company timezone for the transaction; returns the first retained day.
export async function localTime(c: Tx) {
  const { rows: [co] } = await c.query('SELECT timezone, data_retention_days FROM companies WHERE id = app_company_id()');
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
  if (Date.parse(q.to!) - Date.parse(q.from!) > (MAX_RANGE_DAYS - 1) * 86400_000) throw bad('to', `range over ${MAX_RANGE_DAYS} days`);
  const scopes = ['employee_id', 'manager_user_id', 'department'].filter((k) => q[k]);
  if (scopes.length > 1) throw bad(scopes[1], 'at most one of employee_id, manager_user_id, department');
  if (q.manager_user_id && u.team_only && q.manager_user_id !== u.id) throw new ApiError(403, 'FORBIDDEN', 'You see only your own team');
  let ids: string[];
  if (q.employee_id) ids = [(await employeeFor(c, u, q.employee_id)).id];
  else {
    const { rows } = await c.query(
      `SELECT id FROM employees WHERE company_id = app_company_id() AND (NOT $1 OR manager_user_id = $2) AND archived_at IS NULL -- totals leave out archived
         AND ($3::text IS NULL OR manager_user_id::text = $3) AND ($4::text IS NULL OR department = $4)`,
      [u.team_only, u.id, q.manager_user_id ?? null, q.department ?? null],
    );
    ids = rows.map((r) => r.id);
  }
  return { ids, from: q.from! < first ? first : q.from!, to: q.to! };
}

// Summarized days (usage_days, B28) read the summaries; the other days read raw rows, only over the
// span from the first to the last of them (normally just today). Both sets are disjoint.
type Split = { built: string[]; rf: string; rt: string };
async function split(c: Tx, r: Range): Promise<Split> {
  const { rows } = await c.query(
    "SELECT to_char(day, 'YYYY-MM-DD') AS d FROM usage_days WHERE company_id = app_company_id() AND day BETWEEN $1 AND $2", [r.from, r.to]);
  const built = new Set(rows.map((x) => x.d as string));
  const raw = days(r.from, r.to).filter((d) => !built.has(d));
  return { built: [...built], rf: raw[0] ?? addDays(r.to, 1), rt: raw[raw.length - 1] ?? r.to };
}
// Raw rows of unsummarized days: $1 ids, $2 rf, $3 rt, $4 built. Summary rows: $1 ids, $4 built.
// Day bounds are cast to timestamptz: a timestamptz column compared with a date is never an index
// condition, so the time range would be filtered row by row (same result, the cast is what Postgres does).
const RAW = (col: string) =>
  `company_id = app_company_id() AND employee_id = ANY ($1) AND ${col} >= $2::date::timestamptz AND ${col} < ($3::date + 1)::timestamptz AND ${col}::date <> ALL ($4::date[])`;
const SUM = `company_id = app_company_id() AND employee_id = ANY ($1) AND day = ANY ($4::date[])`;

// Per employee and day: tracked time, first/last activity, samples, productivity split.
// Categories are looked up once per distinct app name or domain, then summed.
async function daily(c: Tx, r: Range) {
  const sp = await split(c, r);
  const { rows } = await c.query(
    `WITH s AS (SELECT employee_id, started_at::date AS day, duration_seconds, started_at, ended_at, app_name FROM app_sessions WHERE ${RAW('started_at')}),
          b AS (SELECT employee_id, bucket_start::date AS day, sum(active_samples) AS act, sum(total_samples) AS tot
                  FROM activity_buckets WHERE ${RAW('bucket_start')} GROUP BY 1, 2
                UNION ALL
                SELECT employee_id, day, sum(active_samples), sum(total_samples) FROM usage_hours WHERE ${SUM} AND buckets > 0 GROUP BY 1, 2),
          t AS (SELECT employee_id, day, sum(duration_seconds) AS tracked, min(started_at) AS first_at, max(ended_at) AS last_at FROM s GROUP BY 1, 2
                UNION ALL
                SELECT employee_id, day, sum(tracked_seconds), min(first_at), max(last_at) FROM usage_hours WHERE ${SUM} AND (sessions > 0 OR tracked_seconds > 0) GROUP BY 1, 2),
          items AS (SELECT employee_id, day, 'app' AS kind, app_name AS name, sum(duration_seconds) AS sec FROM s WHERE NOT lower(app_name) = ANY ($5) GROUP BY 1, 2, 4
                UNION ALL
                SELECT employee_id, day, 'app', app_name, seconds FROM usage_apps WHERE ${SUM} AND NOT lower(app_name) = ANY ($5)
                UNION ALL
                SELECT employee_id, visited_at::date, 'domain', domain, sum(duration_seconds) FROM url_visits WHERE ${RAW('visited_at')} GROUP BY 1, 2, 4
                UNION ALL
                SELECT employee_id, day, 'domain', domain, seconds FROM usage_domains WHERE ${SUM}),
          -- MATERIALIZED: categorise each distinct name once, not once per row (inlined it ran per row).
          cats AS MATERIALIZED (SELECT n.kind, n.name, CASE WHEN n.kind = 'app' THEN ${appCat('n.name')} ELSE ${domCat('n.name')} END AS cat
                     FROM (SELECT DISTINCT kind, name FROM items) n),
          pr AS (SELECT employee_id, day, sum(sec) FILTER (WHERE cat = 'productive') AS productive,
                        sum(sec) FILTER (WHERE cat = 'neutral') AS neutral, sum(sec) FILTER (WHERE cat = 'unproductive') AS unproductive
                   FROM items JOIN cats USING (kind, name) GROUP BY 1, 2),
          k AS (SELECT employee_id, day FROM t UNION SELECT employee_id, day FROM b UNION SELECT employee_id, day FROM pr)
     SELECT k.employee_id, to_char(k.day, 'YYYY-MM-DD') AS date, coalesce(t.tracked, 0)::int AS tracked_seconds, t.first_at, t.last_at,
            coalesce(b.act, 0)::int AS act, coalesce(b.tot, 0)::int AS tot, coalesce(pr.productive, 0)::int AS productive_seconds,
            coalesce(pr.neutral, 0)::int AS neutral_seconds, coalesce(pr.unproductive, 0)::int AS unproductive_seconds
       FROM k LEFT JOIN t USING (employee_id, day) LEFT JOIN b USING (employee_id, day) LEFT JOIN pr USING (employee_id, day)`,
    [r.ids, sp.rf, sp.rt, sp.built, BROWSERS],
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
async function periods(c: Tx, r: Range, g: string | undefined, rows?: any[]) {
  if (g === undefined) return undefined;
  if (!['day', 'week', 'month'].includes(g)) throw bad('group_by', 'group_by must be day, week or month');
  const key = (d: string) => g === 'day' ? d : g === 'month' ? d.slice(0, 8) + '01'
    : addDays(d, -((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7));
  rows ??= await daily(c, r);
  const out = new Map<string, any>();
  for (const d of days(r.from, r.to)) {
    const k = key(d);
    if (!out.has(k)) out.set(k, { period_start: k < r.from ? r.from : k, tracked_seconds: 0, act: 0, tot: 0, productive_seconds: 0, neutral_seconds: 0, unproductive_seconds: 0 });
  }
  for (const x of rows) {
    const o = out.get(key(x.date));
    if (o) for (const f of ['tracked_seconds', 'act', 'tot', 'productive_seconds', 'neutral_seconds', 'unproductive_seconds']) o[f] += x[f];
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
      const u = await portalUser(c, req, 'reports');
      const r = await reportRange(c, u, q);
      const limit = q.limit === undefined ? 10 : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw bad('limit', 'limit must be 1–100');
      const offset = q.offset === undefined ? 0 : Number(q.offset);
      if (!/^\d+$/.test(q.offset ?? '0') || offset > 100_000) throw bad('offset', 'offset must be 0–100000');
      const category = q.category ?? null;
      if (category !== null && !CATEGORIES.includes(category)) throw bad('category', 'category must be productive, neutral or unproductive');
      // Category is resolved per row from the rules, so filter after it is computed; ties by name keep pages stable.
      // Raw rows of unsummarized days plus the summaries (B28), then one category per name.
      const [name, raw, col, sum] = kind === 'apps'
        ? ['app_name', 'app_sessions', 'started_at', 'usage_apps'] : ['domain', 'url_visits', 'visited_at', 'usage_domains'];
      const inner = `SELECT x.name AS ${name}, sum(x.sec)::int AS seconds, ${kind === 'apps' ? appCat('x.name') : domCat('x.name')} AS category
          FROM (SELECT ${name} AS name, sum(duration_seconds) AS sec FROM ${raw} WHERE ${RAW(col)} GROUP BY 1
                UNION ALL SELECT ${name}, sum(seconds) FROM ${sum} WHERE ${SUM} GROUP BY 1) x GROUP BY x.name`;
      const sp = await split(c, r);
      const { rows } = await c.query(
        `SELECT * FROM (${inner}) t WHERE ($5::text IS NULL OR t.category = $5) ORDER BY t.seconds DESC, t.${name} LIMIT $6 OFFSET $7`,
        [r.ids, sp.rf, sp.rt, sp.built, category, limit + 1, offset],
      );
      const next_offset = rows.length > limit ? offset + limit : null;
      return { data: { from: r.from, to: r.to, [kind]: rows.slice(0, limit), next_offset } };
    });
  }

  @Get('reports/activity')
  async activity(@Req() req: FastifyRequest, @Query() q: Record<string, string>) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, 'reports');
      const r = await reportRange(c, u, q);
      const sp = await split(c, r);
      const p = [r.ids, sp.rf, sp.rt, sp.built];
      const { rows: [tot] } = await c.query(
        `SELECT ((SELECT coalesce(sum(duration_seconds), 0) FROM app_sessions WHERE ${RAW('started_at')})
                 + (SELECT coalesce(sum(tracked_seconds), 0) FROM usage_hours WHERE ${SUM}))::int AS tracked,
                ((SELECT coalesce(sum(extract(epoch FROM ended_at - started_at)), 0) FROM idle_intervals WHERE ${RAW('started_at')})
                 + (SELECT coalesce(sum(idle_seconds), 0) FROM usage_hours WHERE ${SUM}))::int AS idle,
                ((SELECT coalesce(sum(active_samples), 0) FROM activity_buckets WHERE ${RAW('bucket_start')})
                 + (SELECT coalesce(sum(active_samples), 0) FROM usage_hours WHERE ${SUM}))::int AS act,
                ((SELECT coalesce(sum(total_samples), 0) FROM activity_buckets WHERE ${RAW('bucket_start')})
                 + (SELECT coalesce(sum(total_samples), 0) FROM usage_hours WHERE ${SUM}))::int AS tot`,
        p,
      );
      // Average per day that had session time in that hour; a session is split across the hours it covers.
      const { rows: th } = await c.query(
        `SELECT h, (sum(sec)::float / count(DISTINCT day))::int AS avg
           FROM (SELECT hour AS h, started_at::date AS day, sum(sec) AS sec FROM (${sessionHours(RAW('started_at'))}) s GROUP BY 1, 2
                 UNION ALL SELECT hour, day, sum(tracked_seconds) FROM usage_hours WHERE ${SUM} AND (sessions > 0 OR tracked_seconds > 0) GROUP BY 1, 2) x GROUP BY 1`, p);
      const { rows: bh } = await c.query(
        `SELECT h, sum(act)::int AS act, sum(tot)::int AS tot
           FROM (SELECT extract(hour FROM bucket_start)::int AS h, active_samples AS act, total_samples AS tot FROM activity_buckets WHERE ${RAW('bucket_start')}
                 UNION ALL SELECT hour, active_samples, total_samples FROM usage_hours WHERE ${SUM} AND buckets > 0) x GROUP BY 1`, p);
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
      const u = await portalUser(c, req, 'reports');
      const r = await reportRange(c, u, q);
      const rows = await daily(c, r);
      const sum = (k: string) => rows.reduce((a, x) => a + x[k], 0);
      return { data: { from: r.from, to: r.to, productive_seconds: sum('productive_seconds'), neutral_seconds: sum('neutral_seconds'),
        unproductive_seconds: sum('unproductive_seconds'), tracked_seconds: sum('tracked_seconds'), periods: await periods(c, r, q.group_by, rows) } };
    });
  }

  @Get('employees/:id/calendar')
  async calendar(@Req() req: FastifyRequest, @Param('id') id: string, @Query('view') view: string, @Query('date') date: string) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, 'reports');
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
  async timesheet(@Req() req: FastifyRequest, @Param('id') id: string, @Query() q: Record<string, string | undefined>) {
    const { timezone: _tz, ...data } = await this.sheet(req, id, q);
    return { data };
  }

  // A Monday `week` (seven days), or any `from`..`to` of at most MAX_RANGE_DAYS days.
  private async sheet(req: FastifyRequest, id: string, q: Record<string, string | undefined>, maxDays = MAX_RANGE_DAYS) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, 'reports');
      const e = await employeeFor(c, u, id);
      await localTime(c);
      const week = q.from || q.to ? null : q.week;
      if (!q.from && !q.to && (!isDay(week!) || new Date(week + 'T00:00:00Z').getUTCDay() !== 1)) throw bad('week', 'week must be a Monday, YYYY-MM-DD');
      const from = week ?? q.from!, to = week ? addDays(week, 6) : q.to!;
      if (!week) {
        if (!isDay(from)) throw bad('from', 'from must be YYYY-MM-DD');
        if (!isDay(to)) throw bad('to', 'to must be YYYY-MM-DD');
        if (to < from) throw bad('to', 'to is before from');
        if (Date.parse(to) - Date.parse(from) > (maxDays - 1) * 86400_000) throw bad('to', `range over ${maxDays} days`);
      }
      const raw = await daily(c, { ids: [e.id], from, to });
      const rows = dayRows(raw, days(from, to), await pausedDays(c, e.id, from, to));
      const { rows: [co] } = await c.query('SELECT name, timezone FROM companies WHERE id = app_company_id()');
      const sum = (k: keyof (typeof rows)[0]) => rows.reduce((a, x) => a + (x[k] as number), 0);
      const act = { a: raw.reduce((s, x) => s + x.act, 0), t: raw.reduce((s, x) => s + x.tot, 0) };
      return {
        timezone: co.timezone as string, // for the PDF's clock times only
        employee: { name: e.name, email: e.email }, company: { name: co.name }, week, from, to, days: rows,
        totals: { tracked_seconds: sum('tracked_seconds'), activity_percent: pct(act.a, act.t), productive_seconds: sum('productive_seconds'),
          neutral_seconds: sum('neutral_seconds'), unproductive_seconds: sum('unproductive_seconds') },
      };
    });
  }

  // The JSON timesheet as a one-page PDF, built per request, never stored.
  // shortcut: one page holds about 31 day rows, so the PDF takes at most 31 days; paginate in pdf.ts for longer.
  @Get('employees/:id/timesheet.pdf')
  async timesheetPdf(@Req() req: FastifyRequest, @Param('id') id: string, @Query() q: Record<string, string | undefined>, @Res() res: FastifyReply) {
    const t = await this.sheet(req, id, q, PDF_MAX_DAYS);
    const hm = (s: number) => `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
    const clock = (v: Date | null) => (v ? new Date(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: t.timezone }) : '-');
    const pctTxt = (p: number | null) => (p === null ? '-' : `${p}%`);
    const cols = [50, 130, 185, 240, 310, 370, 440, 510];
    const row = (cells: string[], bold = false) => cells.map((text, i) => ({ text, x: cols[i], bold, gap: i ? 0 : 18 }));
    const pdf = textPdf([
      { text: `Timesheet - ${t.employee.name}`, size: 16, bold: true, gap: 0 },
      { text: `${t.company.name} · ${t.week ? `week of ${t.week}` : `${t.from} to ${t.to}`} · ${t.employee.email ?? ''}`, gap: 22 },
      ...row(['Date', 'First', 'Last', 'Tracked', 'Activity', 'Productive', 'Neutral', 'Unprod.'], true),
      ...t.days.flatMap((d: any) => row([d.date + (d.paused ? ' *' : ''), clock(d.first_activity_at), clock(d.last_activity_at), hm(d.tracked_seconds),
        pctTxt(d.activity_percent), hm(d.productive_seconds), hm(d.neutral_seconds), hm(d.unproductive_seconds)])),
      ...row(['Total', '', '', hm(t.totals.tracked_seconds), pctTxt(t.totals.activity_percent), hm(t.totals.productive_seconds),
        hm(t.totals.neutral_seconds), hm(t.totals.unproductive_seconds)], true),
      { text: `* monitoring was paused on that day. Times in ${t.timezone}.`, size: 8, gap: 28 },
    ]);
    const name = `timesheet-${t.employee.name.replace(/[^\w.-]+/g, '-')}-${t.week ?? `${t.from}-${t.to}`}.pdf`;
    return res.status(200).type('application/pdf').header('Content-Disposition', `attachment; filename="${name}"`).send(pdf);
  }

  // ------------------------------------------------------------ exports

  @Get('exports/:kind')
  async export(@Req() req: FastifyRequest, @Param('kind') kind: string, @Query() q: Record<string, string>, @Res() res: FastifyReply) {
    const csv = await this.db.tx(async (c) => {
      const u = await portalUser(c, req, 'reports');
      const r = await reportRange(c, u, q);
      const p = [r.ids, r.from, r.to, EXPORT_ROW_CAP + 1];
      const ts = (col: string) => `to_char(${col}, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS ${col.split('.').pop()}`;
      let header: string[], rows: any[];
      const tooBig = () => new ApiError(422, 'EXPORT_TOO_LARGE', 'Too many rows; narrow the range', { cap: EXPORT_ROW_CAP });
      // Raw exports count up to the cap first, unsorted, so a huge range stops early instead of sorting it all.
      const capped = async (table: string, col: string) => {
        const { rows: [{ n }] } = await c.query(`SELECT count(*)::int AS n FROM (SELECT 1 FROM ${table} WHERE company_id = app_company_id()
            AND employee_id = ANY ($1) AND ${col} >= $2::date::timestamptz AND ${col} < ($3::date + 1)::timestamptz LIMIT $4) x`, p);
        if (n > EXPORT_ROW_CAP) throw tooBig();
      };
      if (kind === 'app-sessions.csv') {
        await capped('app_sessions', 'started_at');
        header = ['employee_name', 'employee_email', 'category', 'app_name', 'bundle_id', 'process_name', 'window_title', 'started_at', 'ended_at', 'duration_seconds'];
        rows = (await c.query(`SELECT e.name AS employee_name, e.email AS employee_email, ${APP_CAT} AS category, a.app_name, a.bundle_id, a.process_name,
            a.window_title, ${ts('a.started_at')}, ${ts('a.ended_at')}, a.duration_seconds
          FROM app_sessions a JOIN employees e ON e.id = a.employee_id
          WHERE a.company_id = app_company_id() AND a.employee_id = ANY ($1) AND a.started_at >= $2::date::timestamptz AND a.started_at < ($3::date + 1)::timestamptz ORDER BY a.started_at, a.employee_id, a.device_id, a.ended_at, a.app_name, a.window_title LIMIT $4`, p)).rows;
      } else if (kind === 'url-visits.csv') {
        await capped('url_visits', 'visited_at');
        header = ['employee_name', 'employee_email', 'category', 'browser', 'url', 'domain', 'visited_at', 'duration_seconds'];
        rows = (await c.query(`SELECT e.name AS employee_name, e.email AS employee_email, ${DOM_CAT} AS category, v.browser, v.url, v.domain,
            ${ts('v.visited_at')}, v.duration_seconds
          FROM url_visits v JOIN employees e ON e.id = v.employee_id
          WHERE v.company_id = app_company_id() AND v.employee_id = ANY ($1) AND v.visited_at >= $2::date::timestamptz AND v.visited_at < ($3::date + 1)::timestamptz ORDER BY v.visited_at, v.employee_id, v.device_id, v.url LIMIT $4`, p)).rows;
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
      if (rows.length > EXPORT_ROW_CAP) throw tooBig();
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
      // Counted in SQL; `off` and `tampered` must match deviceStatus() and the open_alert badge in devices.controller.
      const { rows: [n] } = await c.query(
        `SELECT count(*) FILTER (WHERE NOT off)::int AS online, count(*) FILTER (WHERE off)::int AS offline, count(*) FILTER (WHERE tampered)::int AS open_alert
           FROM (SELECT d.offline_since IS NOT NULL OR coalesce(d.last_heartbeat_at, d.enrolled_at) < now() - make_interval(mins => $3) AS off,
                        EXISTS (SELECT 1 FROM tamper_events t WHERE t.device_id = d.id AND t.resolved_at IS NULL AND t.event_type <> 'offline') AS tampered
                   FROM devices d JOIN employees e ON e.id = d.employee_id
                  WHERE d.company_id = app_company_id() AND d.released_at IS NULL AND d.deactivated_at IS NULL
                    AND (NOT $1 OR e.manager_user_id = $2)) x`,
        [u.team_only, u.id, OFFLINE_MINUTES],
      );
      const data: Record<string, unknown> = {
        devices: n,
        alerts: can(u, 'alerts.view') ? (await alerts(c, u, {}, 5)).items : [],
      };
      if (can(u, 'reports')) {
        const { today } = await localTime(c);
        const rows = await daily(c, { ids: await scopeEmployeeIds(c, u), from: today, to: today });
        const sum = (k: string) => rows.reduce((a, x) => a + x[k], 0);
        data.today = { tracked_seconds: sum('tracked_seconds'), activity_percent: pct(sum('act'), sum('tot')) };
      }
      if (u.role === 'company_admin') {
        const { rows: [s] } = await c.query(`SELECT seat_limit, (SELECT count(*)::int FROM devices WHERE company_id = app_company_id() AND deactivated_at IS NULL AND released_at IS NULL) AS used
           FROM licenses WHERE company_id = app_company_id()`);
        data.seats = { used: s.used, limit: s.seat_limit };
      }
      return { data };
    });
  }
}
