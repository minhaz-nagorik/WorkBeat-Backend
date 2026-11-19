// Staff area (administer-platform, staff-accounts): super_admin only, staff scope. Reads companies,
// licences, users, invitations, agent releases and company_seat_counts(); never employee, device or
// activity data (D41).
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hashPassword, idOrNone, INVITATION_DAYS, staffUser } from '../auth';
import { DEFAULT_NOTICE, newLicenceKey, temporaryPassword } from '../contract';
import { ApiError, config, Db, encrypt, parse, sha256, token, Tx } from '../core';
import { cmpVersion } from '../device';
import { baseUrl } from '../http';
import { sendMail } from '../mail';
import { Storage } from '../storage';

const TIER_ADDON: Record<string, number> = { off: 0, light: 0.5, standard: 1, intensive: 2 };
const UPLOAD_URL_SECONDS = 60 * 60;
const TEMP_PASSWORD_HOURS = 72;
const email = z.string().trim().toLowerCase().email().max(254);
// Same rule as companies.slug's CHECK (no leading, trailing or double hyphen, ≤ 32), at least 3 characters.
const slug = z.string().min(3).max(32).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const newCompany = z.object({
  name: z.string().trim().min(1).max(100), slug,
  plan: z.enum(['starter', 'growth', 'enterprise']), seat_limit: z.number().int().min(1).nullable(),
  screenshot_tier: z.enum(['off', 'light', 'standard', 'intensive']), status: z.enum(['trial', 'active']),
  trial_days: z.number().int().min(1).max(90).optional(), timezone: z.string().min(1).max(64),
  data_retention_days: z.union([z.literal(30), z.literal(60), z.literal(90)]).optional(), admin_email: email,
  admin_email_2: email.nullable().optional(), // a second Company Admin, optional
}).superRefine((b, ctx) => {
  if (b.admin_email_2 && b.admin_email_2 === b.admin_email) ctx.addIssue({ code: 'custom', path: ['admin_email_2'], message: 'must differ from admin_email' });
  if (b.seat_limit === null && b.plan !== 'enterprise') ctx.addIssue({ code: 'custom', path: ['seat_limit'], message: 'unlimited needs enterprise' });
  if (b.status === 'trial' && b.trial_days === undefined) ctx.addIssue({ code: 'custom', path: ['trial_days'], message: 'required for a trial' });
});
const licencePatch = z.object({
  plan: z.enum(['starter', 'growth', 'enterprise']).optional(),
  seat_limit: z.number().int().min(1).nullable().optional(),
  screenshot_tier: z.enum(['off', 'light', 'standard', 'intensive']).optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'nothing to change' });
const conflict = (field: string, msg: string) => new ApiError(409, 'CONFLICT', msg, { fields: [field] });
const version = z.string().regex(/^\d+\.\d+\.\d+$/);
const release = { product: z.enum(['agent', 'downloader']), platform: z.enum(['macos', 'windows']), arch: z.enum(['universal', 'x64', 'arm64']), version };
const RELEASE = 'id, product, platform, arch, version, min_supported, storage_path, sha256, signature, size_bytes, release_notes, published_by, released_at, withdrawn_at';
const COMPANY = `SELECT c.id, c.name, c.slug, l.plan, l.seat_limit, coalesce(s.seats_used, 0) AS seats_used, l.screenshot_tier, c.status,
    c.suspended_reason, c.custom_domain, c.custom_domain_status, l.trial_ends_at, c.created_at, l.key_last4,
    c.expired_blocking_grace_days, c.custom_domain_checked_at, c.data_retention_days
  FROM companies c JOIN licenses l ON l.company_id = c.id LEFT JOIN company_seat_counts() s ON s.company_id = c.id`;

// An estimate for the staff list; invoices stay in Stripe.
const withMrr = (r: any) => ({ ...r, mrr_estimate: r.status === 'active' ? Math.round(r.seats_used * (1 + TIER_ADDON[r.screenshot_tier]) * 100) / 100 : 0 });
const archOk = (platform: string, arch: string) => (platform === 'macos' ? arch === 'universal' : arch !== 'universal');
const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found`);

async function company(c: Tx, id: string) {
  const { rows: [r] } = await c.query(`${COMPANY} WHERE c.id = $1`, [idOrNone(id)]);
  if (!r) throw notFound('Company');
  return withMrr(r);
}

async function lockCompany(c: Tx, id: string) {
  const { rows: [r] } = await c.query('SELECT id, status FROM companies WHERE id = $1 FOR UPDATE', [idOrNone(id)]);
  if (!r) throw notFound('Company');
  return r;
}

// Staff set any status (B30). trial needs a future trial end: trial_days from now, or the one already set.
// Leaving trial for active is how staff end a trial early.
// expired starts the blocking grace from now; leaving expired clears it. Suspension by staff is reason 'staff'.
async function setStatus(c: Tx, co: { id: string; status: string }, status: string, trialDays?: number) {
  if (status === co.status && trialDays === undefined) return;
  if (status === 'trial') {
    if (trialDays !== undefined)
      await c.query('UPDATE licenses SET trial_ends_at = now() + make_interval(days => $2) WHERE company_id = $1', [co.id, trialDays]);
    const { rows: [l] } = await c.query('SELECT trial_ends_at > now() AS ok FROM licenses WHERE company_id = $1', [co.id]);
    if (!l.ok) throw new ApiError(422, 'VALIDATION_FAILED', 'A trial needs trial_days', { fields: ['trial_days'] });
  }
  // active or expired ends a running trial (trial_ends_at = now), so a later restore can't bring the trial back.
  await c.query(
    `UPDATE licenses SET expired_at = CASE WHEN $2 = 'expired' THEN coalesce(expired_at, now()) END,
            trial_ends_at = CASE WHEN $2 IN ('active', 'expired') AND trial_ends_at > now() THEN now() ELSE trial_ends_at END
      WHERE company_id = $1`,
    [co.id, status],
  );
  await c.query(
    `UPDATE companies SET status = $2,
            suspended_reason = CASE WHEN $2 = 'suspended' THEN coalesce(suspended_reason, 'staff') END,
            suspended_at = CASE WHEN $2 = 'suspended' THEN coalesce(suspended_at, now()) END
      WHERE id = $1`,
    [co.id, status],
  );
}

async function mailStaffInvitation(inviteToken: string, to: string) {
  const link = `${config().PORTAL_URL}/invite?token=${encodeURIComponent(inviteToken)}`;
  await sendMail(to, "You're invited to the WorkBeat staff area",
    `You have been invited to join the WorkBeat staff team.\n\nAccept the invitation: ${link}\n\nThe link expires in ${INVITATION_DAYS} days.`);
}

// An agent release changes every company's policy (new min_agent_version and update package).
const bumpAllPolicies = (c: Tx) => c.query("UPDATE companies SET policy_version = nextval('policy_version_seq')");

@Controller('v1/staff')
export class StaffController {
  constructor(@Inject(Db) private db: Db, @Inject(Storage) private storage: Storage) {}

  // ------------------------------------------------------------ companies

  @Get('companies')
  async companies(@Req() req: FastifyRequest, @Query() q: Record<string, string>) {
    return this.db.tx(async (c) => {
      await staffUser(c, req);
      const f = parse(z.object({ status: z.enum(['trial', 'active', 'suspended', 'expired']).optional(), q: z.string().max(100).optional() }), q, 422);
      const like = f.q ? '%' + f.q.replace(/[\\%_]/g, '\\$&') + '%' : null; // literal match
      const { rows } = await c.query(
        `${COMPANY} WHERE ($1::text IS NULL OR c.status = $1)
           AND ($2::text IS NULL OR c.name ILIKE $2 OR c.slug ILIKE $2 OR l.key_last4 ILIKE $2)
         ORDER BY c.created_at DESC, c.id`,
        [f.status ?? null, like],
      );
      const items = rows.map(withMrr);
      const totals = {
        companies: items.length,
        seats_used: items.reduce((a, r) => a + r.seats_used, 0),
        mrr_estimate: Math.round(items.reduce((a, r) => a + r.mrr_estimate, 0) * 100) / 100,
        suspended: items.filter((r) => r.status === 'suspended').length,
      };
      return { data: { items, totals } };
    });
  }

  // One transaction: company, licence with a new key, default sensitive domains and the first
  // company_admin invitations (one or two). The key and the invitation links go by email only, after commit.
  @Post('companies')
  async create(@Req() req: FastifyRequest, @Body() raw: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    await this.db.tx((c) => staffUser(c, req)); // 401/403 before any validation answer
    const b = parse(newCompany, raw);
    const key = newLicenceKey(), uninstall = token('wbu_');
    const admins = [b.admin_email, b.admin_email_2].filter((e): e is string => !!e).map((email, i) => ({ email, field: i ? 'admin_email_2' : 'admin_email', invite: token('wbi_') }));
    const secret = config().SECRETS_ENCRYPTION_KEY;
    const out = await this.db.tx(async (c) => {
      const u = await staffUser(c, req);
      if (!(await c.query('SELECT is_timezone($1) AS ok', [b.timezone])).rows[0].ok)
        throw new ApiError(422, 'VALIDATION_FAILED', 'Unknown time zone', { fields: ['timezone'] });
      if ((await c.query('SELECT 1 FROM companies WHERE slug = $1', [b.slug])).rowCount) throw conflict('slug', 'This address is taken');
      for (const a of admins) {
        const taken = (await c.query('SELECT email_has_user($1) AS t', [a.email])).rows[0].t
          || (await c.query('SELECT 1 FROM invitations WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()', [a.email])).rowCount;
        if (taken) throw conflict(a.field, 'This email already has an account or an open invitation');
      }
      const { rows: [co] } = await c.query( // slug UNIQUE → 23505 → 409 on a race
        `INSERT INTO companies (name, slug, status, timezone, data_retention_days, uninstall_token_hash, uninstall_token_ciphertext, notice_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [b.name, b.slug, b.status, b.timezone, b.data_retention_days ?? 90, sha256(uninstall), encrypt(uninstall, secret), DEFAULT_NOTICE],
      );
      await c.query(
        `INSERT INTO licenses (company_id, key_hash, key_ciphertext, key_last4, plan, seat_limit, screenshot_tier, trial_ends_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8::int IS NULL THEN NULL ELSE now() + make_interval(days => $8::int) END)`,
        [co.id, sha256(key), encrypt(key, secret), key.slice(-4), b.plan, b.seat_limit, b.screenshot_tier, b.status === 'trial' ? b.trial_days : null],
      );
      await c.query('SELECT company_defaults($1)', [co.id]);
      const invitations = [];
      for (const a of admins)
        invitations.push((await c.query(
          `INSERT INTO invitations (company_id, email, role, token_hash, invited_by, expires_at)
           VALUES ($1, $2, 'company_admin', $3, $4, now() + make_interval(days => $5)) RETURNING email, expires_at`,
          [co.id, a.email, sha256(a.invite), u.id, INVITATION_DAYS],
        )).rows[0]);
      return { company: await company(c, co.id), invitation: invitations[0], invitations };
    });
    for (const a of admins) {
      const link = `${config().PORTAL_URL}/invite?token=${encodeURIComponent(a.invite)}`;
      void sendMail(a.email, `Your WorkBeat account for ${b.name}`,
        `WorkBeat has set up ${b.name} for you.\n\nCreate your Company Admin account: ${link}\n(The link expires in ${INVITATION_DAYS} days.)\n\nYour licence key, for installing WorkBeat on your team's computers:\n${key}\n\nKeep the key private; you can also see it in the console under Licence.`)
        .catch(() => console.error(JSON.stringify({ t: new Date(), level: 'error', err: 'company_created_email_failed' })));
    }
    res.status(201);
    return { data: out };
  }

  @Get('company-admins')
  async companyAdmins(@Req() req: FastifyRequest, @Query() q: Record<string, string>) {
    return this.db.tx(async (c) => {
      await staffUser(c, req);
      const f = parse(z.object({ q: z.string().max(100).optional(), company_id: z.string().uuid().optional() }), q, 422);
      const like = f.q ? '%' + f.q.replace(/[\\%_]/g, '\\$&') + '%' : null; // literal match
      const { rows } = await c.query(
        `SELECT u.id, u.name, u.email, json_build_object('id', c.id, 'name', c.name, 'slug', c.slug) AS company, u.created_at, u.must_change_password
           FROM users u JOIN companies c ON c.id = u.company_id
          WHERE u.role = 'company_admin' AND u.disabled_at IS NULL AND ($1::uuid IS NULL OR c.id = $1)
            AND ($2::text IS NULL OR u.name ILIKE $2 OR u.email::text ILIKE $2 OR c.name ILIKE $2 OR c.slug ILIKE $2)
          ORDER BY u.created_at DESC, u.id`,
        [f.company_id ?? null, like],
      );
      return { data: rows };
    });
  }

  // Shown once to the staff member and emailed to the admin; works once, for 72 hours.
  @Post('users/:id/temporary-password')
  async temporaryPassword(@Req() req: FastifyRequest, @Param('id') id: string, @Res({ passthrough: true }) res: FastifyReply) {
    const pw = temporaryPassword();
    const hash = await hashPassword(pw);
    const r = await this.db.tx(async (c) => {
      await staffUser(c, req);
      const { rows: [u] } = await c.query(
        `UPDATE users SET password_hash = $2, must_change_password = true, password_expires_at = now() + make_interval(hours => $3)
          WHERE id = $1 AND role = 'company_admin' AND disabled_at IS NULL RETURNING id, email, password_expires_at`,
        [idOrNone(id), hash, TEMP_PASSWORD_HOURS],
      );
      if (!u) throw notFound('Company admin');
      await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [u.id]);
      return u;
    });
    void sendMail(r.email, 'Your WorkBeat password was reset',
      `WorkBeat staff reset the password of your WorkBeat account.\n\nTemporary password: ${pw}\n\nIt works for ${TEMP_PASSWORD_HOURS} hours. Sign in with it at ${config().PORTAL_URL} and you will be asked to choose your own password before anything else.`)
      .catch(() => console.error(JSON.stringify({ t: new Date(), level: 'error', err: 'temporary_password_email_failed' })));
    res.status(200).header('Cache-Control', 'no-store');
    return { data: { temporary_password: pw, expires_at: r.password_expires_at } };
  }

  @Get('companies/:id')
  async one(@Req() req: FastifyRequest, @Param('id') id: string) {
    return this.db.tx(async (c) => {
      await staffUser(c, req);
      return { data: await company(c, id) };
    });
  }

  @Post('companies/:id/suspend')
  @HttpCode(200)
  async suspend(@Req() req: FastifyRequest, @Param('id') id: string) {
    return this.db.tx(async (c) => {
      await staffUser(c, req);
      const co = await lockCompany(c, id);
      if (co.status === 'expired') throw new ApiError(409, 'CONFLICT', 'An expired company cannot be suspended');
      await c.query("UPDATE companies SET status = 'suspended', suspended_reason = 'staff', suspended_at = now() WHERE id = $1", [co.id]);
      return { data: await company(c, co.id) };
    });
  }

  @Post('companies/:id/restore')
  @HttpCode(200)
  async restore(@Req() req: FastifyRequest, @Param('id') id: string) {
    return this.db.tx(async (c) => {
      await staffUser(c, req);
      const co = await lockCompany(c, id);
      if (co.status === 'expired') throw new ApiError(409, 'CONFLICT', 'An expired company cannot be restored');
      if (co.status === 'suspended')
        await c.query(
          `UPDATE companies SET status = CASE WHEN (SELECT trial_ends_at FROM licenses WHERE company_id = $1) > now() THEN 'trial' ELSE 'active' END,
                  suspended_reason = NULL, suspended_at = NULL WHERE id = $1`,
          [co.id],
        );
      return { data: await company(c, co.id) };
    });
  }

  @Patch('companies/:id')
  async patch(@Req() req: FastifyRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.db.tx(async (c) => {
      await staffUser(c, req);
      // Name and retention are staff-managed; a company admin can no longer change them (company-settings).
      const b = parse(z.object({
        expired_blocking_grace_days: z.number().int().min(0).max(365).optional(),
        name: z.string().trim().min(1).max(100).optional(),
        data_retention_days: z.union([z.literal(30), z.literal(60), z.literal(90)]).optional(),
        status: z.enum(['trial', 'active', 'suspended', 'expired']).optional(),
        trial_days: z.number().int().min(1).max(90).optional(),
      }), raw, 422);
      const co = await lockCompany(c, id);
      if (b.status) await setStatus(c, co, b.status, b.trial_days);
      await c.query(
        `UPDATE companies SET expired_blocking_grace_days = coalesce($2, expired_blocking_grace_days),
                name = coalesce($3, name), data_retention_days = coalesce($4, data_retention_days) WHERE id = $1`,
        [co.id, b.expired_blocking_grace_days ?? null, b.name ?? null, b.data_retention_days ?? null],
      );
      return { data: await company(c, co.id) };
    });
  }

  // ------------------------------------------------------------ licences

  // Plan, seat limit and screenshot tier, each optional (B30). Unlimited seats (null) only on Enterprise.
  @Patch('companies/:id/license')
  async license(@Req() req: FastifyRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.db.tx(async (c) => {
      await staffUser(c, req);
      const b = parse(licencePatch, raw, 422);
      const co = await lockCompany(c, id);
      const cur = await company(c, co.id);
      const plan = b.plan ?? cur.plan;
      const seatLimit = b.seat_limit !== undefined ? b.seat_limit : cur.seat_limit;
      if (seatLimit === null && plan !== 'enterprise')
        throw new ApiError(422, 'VALIDATION_FAILED', 'Unlimited seats need the Enterprise plan', { fields: ['seat_limit'] });
      if (seatLimit !== null && seatLimit < cur.seats_used)
        throw new ApiError(409, 'CONFLICT', 'Seat limit is below the seats in use', { seats_used: cur.seats_used });
      const tier = b.screenshot_tier ?? cur.screenshot_tier;
      await c.query('UPDATE licenses SET plan = $2, seat_limit = $3, screenshot_tier = $4 WHERE company_id = $1', [co.id, plan, seatLimit, tier]);
      // The tier is in every device's policy (interval capped by it): devices fetch it again.
      if (tier !== cur.screenshot_tier) await c.query("UPDATE companies SET policy_version = nextval('policy_version_seq') WHERE id = $1", [co.id]);
      return { data: await company(c, co.id) };
    });
  }

  @Post('companies/:id/license/reissue')
  async reissue(@Req() req: FastifyRequest, @Param('id') id: string, @Res({ passthrough: true }) res: FastifyReply) {
    const key = newLicenceKey();
    const admins = await this.db.tx(async (c) => {
      await staffUser(c, req);
      const co = await lockCompany(c, id);
      const { rows: [l] } = await c.query(
        `UPDATE licenses SET key_hash = $2, key_ciphertext = $3, key_last4 = $4, key_reset_at = now() WHERE company_id = $1 RETURNING id`,
        [co.id, sha256(key), encrypt(key, config().SECRETS_ENCRYPTION_KEY), key.slice(-4)],
      );
      await c.query('SELECT delete_unused_enrollment_tokens($1)', [l.id]);
      const { rows } = await c.query(
        "SELECT u.email, c.name FROM users u JOIN companies c ON c.id = u.company_id WHERE u.company_id = $1 AND u.role = 'company_admin' AND u.disabled_at IS NULL",
        [co.id],
      );
      return rows;
    });
    // After commit; the key is in the email body only, never in a log line.
    for (const a of admins)
      void sendMail(a.email, `Your WorkBeat licence key was replaced`,
        `WorkBeat staff replaced the licence key of ${a.name}. The old key no longer works for new installs; enrolled devices keep working.\n\nNew licence key: ${key}`)
        .catch(() => console.error(JSON.stringify({ t: new Date(), level: 'error', err: 'reissue_email_failed' })));
    res.status(200).header('Cache-Control', 'no-store');
    return { data: { key } };
  }

  // ------------------------------------------------------------ agent releases

  @Get('agent-releases')
  async releases(@Req() req: FastifyRequest) {
    return this.db.tx(async (c) => {
      await staffUser(c, req);
      const { rows } = await c.query(`SELECT ${RELEASE} FROM agent_releases`);
      return { data: rows.sort((a, b) => cmpVersion(b.version, a.version) || b.released_at - a.released_at) };
    });
  }

  @Post('agent-releases/upload-url')
  @HttpCode(200)
  async uploadUrl(@Req() req: FastifyRequest, @Body() raw: unknown) {
    await this.db.tx((c) => staffUser(c, req));
    const b = parse(z.object(release), raw);
    if (!archOk(b.platform, b.arch)) throw new ApiError(422, 'VALIDATION_FAILED', 'Arch does not fit the platform', { fields: ['arch'] });
    const ext = b.platform === 'macos' ? 'pkg' : b.product === 'agent' ? 'msi' : 'exe';
    const path = `${b.product}/${b.platform}/${b.arch}/${b.version}/${randomBytes(8).toString('hex')}.${ext}`;
    const exp = Math.floor(Date.now() / 1000) + UPLOAD_URL_SECONDS;
    return { data: { upload_url: this.storage.sign(baseUrl(req), 'PUT', 'agents', path, exp), storage_path: path, expires_at: new Date(exp * 1000) } };
  }

  @Post('agent-releases')
  async publish(@Req() req: FastifyRequest, @Body() raw: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    await this.db.tx((c) => staffUser(c, req));
    const b = parse(z.object({
      ...release, min_supported: version, storage_path: z.string().min(1).max(512), sha256: z.string().regex(/^[0-9a-f]{64}$/i),
      signature: z.string().min(1).max(10_000).nullable().optional(), size_bytes: z.number().int().positive(),
      release_notes: z.string().max(10_000).nullable().optional(),
    }), raw);
    const bad = (field: string, msg: string) => new ApiError(422, 'VALIDATION_FAILED', msg, { fields: [field] });
    if (!archOk(b.platform, b.arch)) throw bad('arch', 'Arch does not fit the platform');
    if (cmpVersion(b.min_supported, b.version) > 0) throw bad('min_supported', 'min_supported is above version');
    if (b.platform === 'macos' && !b.signature) throw bad('signature', 'A macOS release needs a signature');
    const size = await this.storage.size('agents', b.storage_path).catch(() => null);
    if (size !== b.size_bytes) throw bad('storage_path', size === null ? 'No uploaded object at storage_path' : 'size_bytes does not match the uploaded object');
    return this.db.tx(async (c) => {
      const u = await staffUser(c, req);
      const { rows: [r] } = await c.query( // UNIQUE (product, platform, arch, version) → 409
        `INSERT INTO agent_releases (product, platform, arch, version, min_supported, storage_path, sha256, signature, size_bytes, release_notes, published_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${RELEASE}`,
        [b.product, b.platform, b.arch, b.version, b.min_supported, b.storage_path, b.sha256.toLowerCase(), b.signature ?? null, b.size_bytes, b.release_notes ?? null, u.id],
      );
      if (r.product === 'agent') await bumpAllPolicies(c);
      res.status(201);
      return { data: r };
    });
  }

  @Post('agent-releases/:id/withdraw')
  @HttpCode(200)
  async withdraw(@Req() req: FastifyRequest, @Param('id') id: string) {
    return this.db.tx(async (c) => {
      await staffUser(c, req);
      const { rows: [r] } = await c.query(`SELECT ${RELEASE} FROM agent_releases WHERE id = $1 FOR UPDATE`, [idOrNone(id)]);
      if (!r) throw notFound('Release');
      if (r.withdrawn_at) return { data: r };
      const { rows: [w] } = await c.query(`UPDATE agent_releases SET withdrawn_at = now() WHERE id = $1 RETURNING ${RELEASE}`, [r.id]);
      if (w.product === 'agent') await bumpAllPolicies(c);
      return { data: w };
    });
  }

  // ------------------------------------------------------------ staff team

  @Get('team')
  async team(@Req() req: FastifyRequest) {
    return this.db.tx(async (c) => {
      await staffUser(c, req);
      const [users, invitations] = await Promise.all([
        c.query("SELECT id, name, email, created_at FROM users WHERE role = 'super_admin' AND disabled_at IS NULL ORDER BY name"),
        c.query('SELECT id, email, created_at, expires_at FROM invitations WHERE company_id IS NULL AND accepted_at IS NULL AND revoked_at IS NULL ORDER BY created_at'),
      ]);
      return { data: { users: users.rows, invitations: invitations.rows } };
    });
  }

  @Post('invitations')
  async invite(@Req() req: FastifyRequest, @Body() raw: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    return this.db.tx(async (c) => {
      const u = await staffUser(c, req);
      const b = parse(z.object({ email: z.string().trim().toLowerCase().email().max(254) }), raw);
      if ((await c.query('SELECT email_has_user($1) AS taken', [b.email])).rows[0].taken) throw new ApiError(409, 'CONFLICT', 'This email already has an account');
      const t = token('wbi_');
      const { rows: [inv] } = await c.query( // invitations_one_open → 23505 → 409 CONFLICT
        `INSERT INTO invitations (company_id, email, role, token_hash, invited_by, expires_at)
         VALUES (NULL, $1, 'super_admin', $2, $3, now() + make_interval(days => $4)) RETURNING id, email, role, expires_at`,
        [b.email, sha256(t), u.id, INVITATION_DAYS],
      );
      await mailStaffInvitation(t, b.email);
      res.status(201);
      return { data: inv };
    });
  }

  @Post('invitations/:id/resend')
  @HttpCode(200)
  async resend(@Req() req: FastifyRequest, @Param('id') id: string) {
    return this.db.tx(async (c) => {
      await staffUser(c, req);
      const inv = await this.staffInvitation(c, id);
      if (inv.accepted_at || inv.revoked_at) throw new ApiError(409, 'CONFLICT', 'Invitation is not open');
      const t = token('wbi_');
      const { rows: [row] } = await c.query(
        'UPDATE invitations SET token_hash = $2, expires_at = now() + make_interval(days => $3) WHERE id = $1 RETURNING id, email, role, expires_at',
        [inv.id, sha256(t), INVITATION_DAYS],
      );
      await mailStaffInvitation(t, row.email);
      return { data: row };
    });
  }

  @Delete('invitations/:id')
  async revoke(@Req() req: FastifyRequest, @Param('id') id: string, @Res({ passthrough: true }) res: FastifyReply) {
    await this.db.tx(async (c) => {
      await staffUser(c, req);
      const inv = await this.staffInvitation(c, id);
      if (inv.accepted_at) throw new ApiError(409, 'CONFLICT', 'Invitation already accepted');
      await c.query('UPDATE invitations SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1', [inv.id]);
    });
    res.status(204);
  }

  private async staffInvitation(c: Tx, id: string) {
    const { rows: [inv] } = await c.query('SELECT id, accepted_at, revoked_at FROM invitations WHERE id = $1 AND company_id IS NULL FOR UPDATE', [idOrNone(id)]);
    if (!inv) throw notFound('Invitation');
    return inv;
  }

  @Delete('users/:id')
  async removeUser(@Req() req: FastifyRequest, @Param('id') id: string, @Res({ passthrough: true }) res: FastifyReply) {
    await this.db.tx(async (c) => {
      const me = await staffUser(c, req);
      const { rows: staff } = await c.query("SELECT id FROM users WHERE role = 'super_admin' AND disabled_at IS NULL FOR UPDATE");
      const target = staff.find((s) => s.id === idOrNone(id));
      if (!target) throw notFound('User');
      if (target.id === me.id) throw new ApiError(409, 'CONFLICT', 'You cannot remove yourself');
      if (staff.length < 2) throw new ApiError(409, 'CONFLICT', 'The last staff member cannot be removed');
      await c.query('UPDATE users SET disabled_at = now() WHERE id = $1', [target.id]);
      await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [target.id]);
    });
    res.status(204);
  }
}
