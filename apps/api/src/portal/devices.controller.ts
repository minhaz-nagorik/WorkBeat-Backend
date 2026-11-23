// Devices with derived status and badges, rollout counts, release, portal deactivate, alerts feed.
import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { idOrNone, portalUser, User } from '../auth';
import { ApiError, Db, Tx } from '../core';
import { cmpVersion, newestRelease } from '../device';
import { HEALTH_FIELDS } from '../contract';

export const OFFLINE_MINUTES = 15;
const ALERT_PAGE = 50;
const DEVICE = `d.id, d.hostname, d.os, d.os_version, d.arch, d.agent_version, d.last_heartbeat_at, d.released_at, d.deactivated_at,
  d.offline_since, d.enrolled_at, d.permissions, d.browser_access, d.helper_status, d.health, d.active_pause_id,
  d.notice_ack_version, d.reported_policy_version,
  json_build_object('id', e.id, 'name', e.name) AS employee,
  EXISTS (SELECT 1 FROM tamper_events t WHERE t.device_id = d.id AND t.resolved_at IS NULL AND t.event_type <> 'offline') AS tampered,
  EXISTS (SELECT 1 FROM monitoring_pauses p WHERE p.employee_id = d.employee_id AND p.cancelled_at IS NULL
          AND p.starts_at <= now() AND p.ends_at > now()) AS paused`;

// device-status: first that applies, never stored.
// shortcut: "offline" also derived from a heartbeat older than 15 min, until /cron/offline sets offline_since.
export function deviceStatus(d: any) {
  if (d.released_at) return 'released';
  if (d.deactivated_at) return 'deactivated';
  const seen = (d.last_heartbeat_at ?? d.enrolled_at).getTime();
  if (d.offline_since || Date.now() - seen > OFFLINE_MINUTES * 60_000) return 'offline';
  return 'online';
}

async function withStatus(c: Tx, rows: any[], detail = false) {
  const { rows: [co] } = await c.query('SELECT min_agent_version FROM companies WHERE id = app_company_id()');
  const mins = new Map<string, string | null>();
  for (const d of rows) {
    const k = `${d.os}/${d.arch}`;
    if (!mins.has(k)) {
      const rel = await newestRelease(c, d.os, d.arch);
      let m: string | null = co.min_agent_version;
      if (rel && (!m || cmpVersion(rel.min_supported, m) > 0)) m = rel.min_supported;
      mins.set(k, m);
    }
  }
  return rows.map((d) => {
    const min = mins.get(`${d.os}/${d.arch}`);
    const perms = d.permissions && typeof d.permissions === 'object' ? Object.values(d.permissions) : [];
    const browsers = d.browser_access && typeof d.browser_access === 'object' ? Object.values(d.browser_access) : [];
    const badges = [
      ...(min && cmpVersion(d.agent_version, min) < 0 ? ['outdated'] : []),
      ...(d.os === 'macos' && perms.some((p) => p !== 'granted') ? ['permission_pending'] : []),
      ...(browsers.some((b) => b === 'pending' || b === 'unreadable') ? ['browser_access_pending'] : []),
      ...(d.active_pause_id || d.paused ? ['paused'] : []),
      ...(d.tampered ? ['open_alert'] : []), // B31: an open tamper alert is a badge, not a status
    ];
    const base = { id: d.id, hostname: d.hostname, os: d.os, os_version: d.os_version, arch: d.arch, agent_version: d.agent_version,
      employee: d.employee, status: deviceStatus(d), badges, last_heartbeat_at: d.last_heartbeat_at,
      released_at: d.released_at, deactivated_at: d.deactivated_at };
    // health: the latest heartbeat's counters, every key present (null before the first heartbeat).
    const health = { ...Object.fromEntries(HEALTH_FIELDS.map((f) => [f, null])), ...(d.health ?? {}),
      outdated: badges.includes('outdated'), notice_ack_version: d.notice_ack_version, reported_policy_version: d.reported_policy_version };
    return detail ? { ...base, helper_status: d.helper_status, browser_access: d.browser_access, permissions: d.permissions, health } : base;
  });
}

export async function listDevices(c: Tx, where = 'true', params: unknown[] = [], detail = false) {
  const { rows } = await c.query(`SELECT ${DEVICE} FROM devices d JOIN employees e ON e.id = d.employee_id WHERE d.company_id = app_company_id() AND (${where}) ORDER BY d.hostname, d.id`, params);
  return withStatus(c, rows, detail);
}

export async function deviceOne(c: Tx, id: string, lock = false): Promise<any> {
  if (lock) await c.query('SELECT 1 FROM devices WHERE id = $1 FOR UPDATE', [idOrNone(id)]);
  const [d] = await listDevices(c, 'd.id = $1', [idOrNone(id)], true);
  if (!d) throw new ApiError(404, 'NOT_FOUND', 'Device not found');
  return d;
}

// Portal side of POST /v1/devices/:id/deactivate (device-lifecycle): idempotent, 409 when released.
export async function deactivateAsUser(c: Tx, req: FastifyRequest, id: string) {
  await portalUser(c, req, 'devices.edit');
  const d = await deviceOne(c, id, true);
  if (d.released_at) throw new ApiError(409, 'CONFLICT', 'Device is released');
  await c.query('UPDATE devices SET deactivated_at = coalesce(deactivated_at, now()), key_hash = NULL WHERE id = $1', [d.id]);
  return deviceOne(c, id);
}

// alerts-feed: the caller's events, newest first; a team-only role sees devices of own team only.
const ALERT_FROM = `FROM tamper_events t JOIN devices d ON d.id = t.device_id JOIN employees e ON e.id = d.employee_id
  WHERE t.company_id = app_company_id() AND (NOT $1 OR e.manager_user_id = $2)
    AND ($3::text[] IS NULL OR t.event_type = ANY ($3))
    AND ($4::text IS NULL OR ($4 = 'open') = (t.resolved_at IS NULL))
    AND ($5::uuid IS NULL OR t.device_id = $5)
    AND ($6::timestamptz IS NULL OR t.occurred_at >= $6) AND ($7::timestamptz IS NULL OR t.occurred_at <= $7)
    AND ($8::uuid IS NULL OR d.employee_id = $8)
    AND ($9::text IS NULL OR t.event_type ILIKE $9 OR t.hostname ILIKE $9 OR e.name ILIKE $9 OR t.detail::text ILIKE $9)`;

export async function alerts(c: Tx, u: User, q: Record<string, string | undefined>, limit = ALERT_PAGE, withCounts = false) {
  const types = q.type ? q.type.split(',') : null;
  let cursorAt: string | null = null, cursorId: string | null = null;
  if (q.cursor) [cursorAt, cursorId] = Buffer.from(q.cursor, 'base64url').toString().split('|');
  const filters = [u.team_only, u.id, types, q.state ?? null, q.device_id ? idOrNone(q.device_id) : null, q.from ?? null, q.to ?? null,
    q.employee_id ? idOrNone(q.employee_id) : null,
    // q: free text over event type, hostname, employee name and detail (labels are the web platform's)
    q.q ? `%${q.q.slice(0, 100).replace(/[\\%_]/g, (ch) => '\\' + ch)}%` : null];
  const { rows } = await c.query(
    `SELECT t.id, t.event_type, t.device_id, t.hostname, json_build_object('id', e.id, 'name', e.name) AS employee,
            t.detail, t.repeat_count, t.occurred_at, t.received_at, t.resolved_at, t.resolved_by,
            (SELECT name FROM users u WHERE u.id = t.resolved_by) AS resolved_by_name
       ${ALERT_FROM}
        AND ($10::timestamptz IS NULL OR (t.occurred_at, t.id) < ($10, $11::uuid))
        AND ($12::uuid IS NULL OR t.id = $12)
      ORDER BY t.occurred_at DESC, t.id DESC LIMIT $13`,
    [...filters, cursorAt, cursorId, q.id ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const next = rows.length > limit && last ? Buffer.from(`${last.occurred_at.toISOString()}|${last.id}`).toString('base64url') : null;
  if (!withCounts) return { items: page, next_cursor: next };
  // Per type for the same filters without `type`, for the type dropdown.
  const { rows: cnt } = await c.query(`SELECT t.event_type, count(*)::int AS n ${ALERT_FROM} GROUP BY 1`, [...filters.slice(0, 2), null, ...filters.slice(3)]);
  return { items: page, next_cursor: next, counts: Object.fromEntries(cnt.map((r) => [r.event_type, r.n])) };
}

@Controller('v1')
export class DevicesController {
  constructor(@Inject(Db) private db: Db) {}

  @Get('devices')
  async list(@Req() req: FastifyRequest, @Query() q: Record<string, string>) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, 'devices.view');
      let rows = await listDevices(c, '($1::text IS NULL OR d.os = $1) AND ($2::uuid IS NULL OR d.employee_id = $2)',
        [q.os ?? null, q.employee_id ? idOrNone(q.employee_id) : null]);
      if (q.status) rows = rows.filter((d) => d.status === q.status);
      if (q.badge) rows = rows.filter((d) => d.badges.includes(q.badge));
      return { data: rows };
    });
  }

  @Get('devices/:id')
  async get(@Req() req: FastifyRequest, @Param('id') id: string) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, 'devices.view');
      return { data: await this.one(c, id) };
    });
  }

  @Get('rollout')
  async rollout(@Req() req: FastifyRequest) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, 'deployment');
      const rows = await listDevices(c);
      const status: Record<string, number> = { online: 0, offline: 0, deactivated: 0, released: 0 };
      const badges: Record<string, number> = { outdated: 0, permission_pending: 0, browser_access_pending: 0, paused: 0, open_alert: 0 };
      for (const d of rows) {
        status[d.status]++;
        for (const b of d.badges) badges[b]++;
      }
      return { data: { status, badges, healthy: rows.filter((d) => d.status === 'online' && !d.badges.length).length } };
    });
  }

  @Post('devices/:id/release')
  @HttpCode(200)
  async release(@Req() req: FastifyRequest, @Param('id') id: string) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, 'devices.edit');
      const d = await this.one(c, id, true);
      if (d.released_at) throw new ApiError(409, 'CONFLICT', 'Device already released');
      await c.query('UPDATE devices SET released_at = now() WHERE id = $1', [d.id]);
      return { data: await this.one(c, id) };
    });
  }

  private one(c: Tx, id: string, lock = false) {
    return deviceOne(c, id, lock);
  }

  @Get('alerts')
  async alerts(@Req() req: FastifyRequest, @Query() q: Record<string, string>) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, 'alerts.view');
      for (const k of ['from', 'to'] as const)
        if (q[k] && isNaN(Date.parse(q[k]))) throw new ApiError(422, 'VALIDATION_FAILED', `${k} must be an ISO date`, { fields: [k] });
      return { data: await alerts(c, u, q, ALERT_PAGE, true) };
    });
  }

  @Post('alerts/:id/resolve')
  @HttpCode(200)
  async resolve(@Req() req: FastifyRequest, @Param('id') id: string) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, 'alerts.edit');
      const r = await c.query('UPDATE tamper_events SET resolved_at = coalesce(resolved_at, now()), resolved_by = CASE WHEN resolved_at IS NULL THEN $2::uuid ELSE resolved_by END WHERE id = $1 RETURNING id', [idOrNone(id), u.id]);
      if (!r.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Alert not found');
      return { data: (await alerts(c, u, { id: r.rows[0].id })).items[0] };
    });
  }
}
