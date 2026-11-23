// Company status, billing (read-only, no Stripe yet), settings, setup, licence and deployment.
import { Body, Controller, Delete, Get, Inject, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ADMIN, ALL, NO_COMPANY_ROLE, portalUser } from '../auth';
import { ApiError, config, Db, decrypt, parse, Tx } from '../core';
import { baseUrl } from '../http';
import { cmpVersion } from '../device';
import { Storage } from '../storage';
import { clearSummaries } from '../usage';
import { isBareHost } from './policy.controller';

const EVENT_TYPES = ['process_restart', 'hosts_modified', 'config_changed', 'clock_tampered', 'permission_revoked', 'offline', 'duplicate_device_id'] as const;
// name and data_retention_days are set by staff (staff-companies); a company admin sending them gets 403.
const STAFF_FIELDS = ['name', 'data_retention_days'];
const settingsPatch = z.object({
  idle_threshold_seconds: z.number().int().min(60).max(3600).optional(),
  alert_email: z.object({
    roles: z.array(z.union([z.literal('company_admin'), z.string().uuid()])).min(1), // 'company_admin' or a role id
    types: z.array(z.enum(EVENT_TYPES)),
    delivery: z.enum(['instant', 'hourly', 'daily']),
  }).optional(),
  timezone: z.string().min(1).max(64).optional(), // checked by companies_timezone_check → 422
});
const SETTINGS = 'name, slug, data_retention_days, idle_threshold_seconds, alert_email, timezone';
const SEATS_USED = '(SELECT count(*)::int FROM devices WHERE company_id = app_company_id() AND deactivated_at IS NULL AND released_at IS NULL)';
const DOWNLOAD_URL_SECONDS = 15 * 60;
const CNAME_TARGET = 'proxy.workbeat.io';

// The custom domain of company `id` with the DNS records to create; the caller's company when `id` is null.
export async function customDomain(c: Tx, id: string | null = null) {
  const { rows: [r] } = await c.query(
    `SELECT custom_domain AS domain, custom_domain_status AS status, custom_domain_token AS token, custom_domain_checked_at AS checked_at,
            custom_domain_verified_at AS verified_at FROM companies WHERE id = coalesce($1::uuid, app_company_id())`, [id],
  );
  if (!r?.domain) return null;
  const { token, ...rest } = r;
  return { ...rest, cname_target: CNAME_TARGET, txt_name: `_workbeat.${r.domain}`, txt_value: `verify-${token}` };
}

// A company admin sets the domain; it stays pending until staff approve it (B33). The same domain again keeps its status and token.
// custom_domain UNIQUE → 23505 → 409 for another company's.
export async function setCustomDomain(c: Tx, id: string, raw: unknown) {
  const b = parse(z.object({ domain: z.string().max(253) }), raw, 422);
  const domain = b.domain.trim().toLowerCase().replace(/\.$/, '');
  if (!isBareHost(domain) || !domain.includes('.') || domain === 'workbeat.io' || domain.endsWith('.workbeat.io'))
    throw new ApiError(422, 'VALIDATION_FAILED', 'Not a host name you can use', { fields: ['domain'] });
  await c.query(
    `UPDATE companies SET custom_domain = $2, custom_domain_status = 'pending', custom_domain_token = $3,
            custom_domain_checked_at = NULL, custom_domain_verified_at = NULL
      WHERE id = $1 AND custom_domain IS DISTINCT FROM $2::citext`,
    [id, domain, randomBytes(16).toString('hex')],
  );
  return customDomain(c, id);
}

export const CLEAR_DOMAIN = `custom_domain = NULL, custom_domain_status = NULL, custom_domain_token = NULL,
  custom_domain_checked_at = NULL, custom_domain_verified_at = NULL`;

@Controller('v1')
export class CompanyController {
  constructor(@Inject(Db) private db: Db, @Inject(Storage) private storage: Storage) {}

  @Get('company/status')
  async status(@Req() req: FastifyRequest) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, ALL);
      const { rows: [r] } = await c.query(
        `SELECT c.status, c.suspended_reason, l.trial_ends_at, l.expired_at,
                l.expired_at + make_interval(days => c.expired_blocking_grace_days) AS blocking_ends_at
           FROM companies c JOIN licenses l ON l.company_id = c.id`,
      );
      return { data: r };
    });
  }

  // Billing is handled by WorkBeat staff: every company role gets 403. The handler stays for when that changes.
  @Get('billing')
  async billing(@Req() req: FastifyRequest) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, NO_COMPANY_ROLE);
      const { rows: [r] } = await c.query(
        `SELECT plan, seat_limit, ${SEATS_USED} AS seats_used, screenshot_tier, trial_ends_at, current_period_end FROM licenses`,
      );
      return { data: { ...r, scheduled_screenshot_tier: null, scheduled_at: null } };
    });
  }

  @Get('company/settings')
  async settings(@Req() req: FastifyRequest) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      return { data: (await c.query(`SELECT ${SETTINGS} FROM companies`)).rows[0] };
    });
  }

  @Patch('company/settings')
  async patchSettings(@Req() req: FastifyRequest, @Body() raw: unknown) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      const staffOnly = raw && typeof raw === 'object' ? STAFF_FIELDS.filter((f) => f in raw) : [];
      if (staffOnly.length) throw new ApiError(403, 'FORBIDDEN', 'WorkBeat sets these for your company', { fields: staffOnly });
      const b = parse(settingsPatch, raw, 422);
      const { rows: [old] } = await c.query('SELECT timezone FROM companies WHERE id = app_company_id()');
      const { rows: [r] } = await c.query(
        `UPDATE companies SET idle_threshold_seconds = coalesce($1, idle_threshold_seconds), alert_email = coalesce($2, alert_email),
                timezone = coalesce($3, timezone)
          WHERE id = app_company_id() RETURNING ${SETTINGS}`,
        [b.idle_threshold_seconds ?? null, b.alert_email ? JSON.stringify(b.alert_email) : null, b.timezone ?? null],
      );
      if (r.timezone !== old.timezone) await clearSummaries(c); // days moved: rebuilt by /cron/usage-summary (B28)
      return { data: r };
    });
  }

  @Get('company/setup')
  async setup(@Req() req: FastifyRequest) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      const { rows: [r] } = await c.query(
        `SELECT setup_completed_steps AS s, EXISTS (SELECT 1 FROM devices WHERE company_id = app_company_id()) AS installed,
                EXISTS (SELECT 1 FROM devices WHERE company_id = app_company_id() AND last_heartbeat_at IS NOT NULL) AS seen
           FROM companies WHERE id = app_company_id()`,
      );
      return { data: [
        { step: 'download_downloader', done: r.s.includes('download_downloader') },
        { step: 'copy_license_key', done: r.s.includes('copy_license_key') },
        { step: 'install_first_device', done: r.installed },
        { step: 'first_device_seen', done: r.seen },
      ] };
    });
  }

  @Post('company/setup/steps')
  async setupStep(@Req() req: FastifyRequest, @Body() raw: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    await this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      const b = parse(z.object({ step: z.enum(['download_downloader', 'copy_license_key']) }), raw, 422);
      await c.query(
        `UPDATE companies SET setup_completed_steps = array_append(setup_completed_steps, $1)
          WHERE id = app_company_id() AND NOT ($1 = ANY (setup_completed_steps))`,
        [b.step],
      );
    });
    res.status(204);
  }

  @Get('license')
  async license(@Req() req: FastifyRequest) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      const { rows: [r] } = await c.query(`SELECT key_last4, plan, seat_limit, ${SEATS_USED} AS seats_used, key_reset_at, (SELECT min_agent_version FROM companies) FROM licenses`);
      return { data: { key_masked: `WB-••••-••••-••••-${r.key_last4}`, plan: r.plan, seat_limit: r.seat_limit, seats_used: r.seats_used, key_reset_at: r.key_reset_at,
        min_agent_version: r.min_agent_version } };
    });
  }

  @Post('license/reveal')
  async revealKey(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      const { rows: [r] } = await c.query('SELECT key_ciphertext FROM licenses');
      res.status(200).header('Cache-Control', 'no-store');
      return { data: { key: decrypt(r.key_ciphertext, config().SECRETS_ENCRYPTION_KEY) } };
    });
  }

  @Post('license/uninstall-token/reveal')
  async revealUninstall(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      const { rows: [r] } = await c.query('SELECT uninstall_token_ciphertext FROM companies');
      res.status(200).header('Cache-Control', 'no-store');
      return { data: { uninstall_token: decrypt(r.uninstall_token_ciphertext, config().SECRETS_ENCRYPTION_KEY) } };
    });
  }

  // Newest non-withdrawn release per product, platform and arch, with a signed link.
  @Get('downloads')
  async downloads(@Req() req: FastifyRequest) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, 'deployment');
      const { rows } = await c.query(
        'SELECT product, platform, arch, version, size_bytes, sha256, storage_path FROM agent_releases WHERE withdrawn_at IS NULL',
      );
      const newest = new Map<string, any>();
      for (const r of rows) {
        const k = `${r.product}/${r.platform}/${r.arch}`;
        if (!newest.has(k) || cmpVersion(r.version, newest.get(k).version) > 0) newest.set(k, r);
      }
      const exp = Math.floor(Date.now() / 1000) + DOWNLOAD_URL_SECONDS;
      return { data: [...newest.values()].map(({ storage_path, ...r }) => ({
        ...r, url: this.storage.sign(baseUrl(req), 'GET', 'agents', storage_path, exp), expires_at: new Date(exp * 1000),
      })) };
    });
  }

  // Live agent versions per platform, newest first, for the minimum-version picker (admin request 2.7).
  @Get('agent-versions')
  async agentVersions(@Req() req: FastifyRequest) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, 'deployment');
      const { rows } = await c.query("SELECT DISTINCT platform, version FROM agent_releases WHERE product = 'agent' AND withdrawn_at IS NULL");
      const out: Record<string, string[]> = { macos: [], windows: [] };
      for (const r of rows) out[r.platform].push(r.version);
      for (const k of Object.keys(out)) out[k].sort((a, b) => cmpVersion(b, a));
      return { data: out };
    });
  }

  @Put('deployment/min-agent-version')
  async minVersion(@Req() req: FastifyRequest, @Body() raw: unknown) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      const b = parse(z.object({ min_agent_version: z.string().regex(/^\d+\.\d+\.\d+$/).nullable() }), raw, 422);
      const { rows: [r] } = await c.query('UPDATE companies SET min_agent_version = $1 WHERE id = app_company_id() RETURNING min_agent_version', [b.min_agent_version]);
      return { data: r };
    });
  }

  // ------------------------------------------------------------ custom domain (custom-domains)
// A company admin sets, reads and removes the domain; only staff approval makes it active (B33).

  @Get('company/custom-domain')
  async getDomain(@Req() req: FastifyRequest) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      return { data: await customDomain(c) };
    });
  }

  @Put('company/custom-domain')
  async putDomain(@Req() req: FastifyRequest, @Body() raw: unknown) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN);
      return { data: await setCustomDomain(c, u.company_id, raw) };
    });
  }

  @Delete('company/custom-domain')
  async deleteDomain(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    await this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      await c.query(`UPDATE companies SET ${CLEAR_DOMAIN} WHERE id = app_company_id()`);
    });
    res.status(204);
  }

  // No credential: the sign-in page shows whose page it is. Only through company_by_host (B3).
  @Get('hosts/resolve')
  async resolveHost(@Query('host') host: string) {
    if (typeof host !== 'string' || !host || host.length > 253) throw new ApiError(422, 'VALIDATION_FAILED', 'host is required', { fields: ['host'] });
    return this.db.tx(async (c) => {
      const { rows: [r] } = await c.query('SELECT company_by_host($1) AS id', [host.trim().toLowerCase()]);
      if (!r.id) throw new ApiError(404, 'NOT_FOUND', 'Unknown host');
      await c.tenant(r.id);
      const { rows: [co] } = await c.query('SELECT name, slug FROM companies');
      return { data: co };
    });
  }
}
