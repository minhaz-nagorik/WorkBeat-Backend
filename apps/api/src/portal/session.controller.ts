// Sign-in, invitations and the team (authenticate-users). Own auth replaces Supabase Auth (0004).
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ADMIN, ALL, bearer, hashPassword, idOrNone, INVITATION_DAYS, newSession, portalUser, User, verifyPassword } from '../auth';
import { ApiError, config, Db, parse, sha256, token, Tx } from '../core';
import { sendMail } from '../mail';

const RESET_MINUTES = 30;

const password = z.string().min(10).max(200);
const email = z.string().trim().toLowerCase().email().max(254);
const companyRole = z.enum(['company_admin', 'manager', 'it_admin']);

async function me(c: Tx, u: User) {
  const company = u.company_id
    ? (await c.query('SELECT id, name, slug, status, timezone FROM companies WHERE id = $1', [u.company_id])).rows[0] ?? null
    : null;
  return { id: u.id, email: u.email, name: u.name, role: u.role, company, must_change_password: !!u.must_change_password };
}

async function mailInvitation(c: Tx, inviteToken: string, to: string, role: string) {
  const { rows: [co] } = await c.query('SELECT name FROM companies WHERE id = app_company_id()');
  const link = `${config().PORTAL_URL}/invite?token=${encodeURIComponent(inviteToken)}`;
  await sendMail(to, `You're invited to ${co.name} on WorkBeat`,
    `You have been invited to ${co.name} on WorkBeat as ${role.replace('_', ' ')}.\n\nAccept the invitation: ${link}\n\nThe link expires in ${INVITATION_DAYS} days.`);
}

// The last enabled company_admin can be neither demoted nor removed.
async function assertAnotherAdmin(c: Tx, userId: string) {
  const { rows } = await c.query("SELECT id FROM users WHERE role = 'company_admin' AND disabled_at IS NULL FOR UPDATE");
  if (!rows.some((r) => r.id !== userId)) throw new ApiError(409, 'CONFLICT', 'The company needs at least one company admin');
}

@Controller('v1')
export class SessionController {
  constructor(@Inject(Db) private db: Db) {}

  @Post('auth/login')
  @HttpCode(200)
  async login(@Body() raw: unknown) {
    const b = parse(z.object({ email, password: z.string().max(200) }), raw);
    return this.db.tx(async (c) => {
      const { rows: [u] } = await c.query('SELECT * FROM auth_login($1)', [b.email]);
      const expired = u?.must_change_password && !(u.password_expires_at > new Date()); // a temporary password works 72 hours
      if (!(await verifyPassword(b.password, u?.password_hash)) || expired || (u.role !== 'super_admin' && !u.company_id))
        throw new ApiError(401, 'UNAUTHENTICATED', 'Wrong email or password');
      // Staff sign in with password only, like company users (MFA removed by the product owner, 16 Nov 2026).
      return { data: await this.session(c, u.user_id) };
    });
  }

  private async session(c: Tx, userId: string) {
    const s = await newSession(c, userId);
    const { rows: [full] } = await c.query('SELECT * FROM auth_session($1)', [sha256(s.token)]);
    if (full.company_id) await c.tenant(full.company_id); // companies is under RLS: without it `company` comes back null
    return { ...s, user: await me(c, { ...full, id: full.user_id }) };
  }

  // ------------------------------------------------------------ password reset

  // Always 204, so the answer never tells whether the email has an account.
  @Post('auth/password-reset/request')
  async resetRequest(@Body() raw: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    const b = parse(z.object({ email }), raw);
    const sent = await this.db.tx(async (c) => {
      const { rows: [u] } = await c.query('SELECT * FROM auth_login($1)', [b.email]);
      if (!u) return null;
      const t = token('wbr_');
      await c.query('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))',
        [u.user_id, sha256(t), RESET_MINUTES]);
      return t;
    });
    // Sent after the answer: no timing difference between known and unknown emails.
    if (sent) void sendMail(b.email, 'Reset your WorkBeat password',
      `Someone asked to reset the password of this WorkBeat account.\n\nChoose a new password: ${config().PORTAL_URL}/reset-password?token=${encodeURIComponent(sent)}\n\nThe link works once and expires in ${RESET_MINUTES} minutes. If you did not ask for this, ignore this email.`)
      .catch((e) => console.error(JSON.stringify({ t: new Date(), level: 'error', err: 'reset_email_failed', reason: e?.message })));
    res.status(204);
  }

  @Post('auth/password-reset/confirm')
  @HttpCode(200)
  async resetConfirm(@Body() raw: unknown) {
    const b = parse(z.object({ token: z.string().min(1).max(200), new_password: password }), raw);
    const hash = await hashPassword(b.new_password);
    return this.db.tx(async (c) => {
      const { rows: [r] } = await c.query('SELECT * FROM auth_password_reset($1)', [sha256(b.token)]);
      if (!r) throw new ApiError(404, 'PASSWORD_RESET_INVALID', 'Reset link not found');
      if (!r.usable) throw new ApiError(410, 'PASSWORD_RESET_EXPIRED', 'Reset link used or expired');
      if (r.company_id) await c.tenant(r.company_id);
      else await c.query("SELECT set_config('app.scope', 'staff', true)");
      const claimed = await c.query('UPDATE password_resets SET used_at = now() WHERE id = $1 AND used_at IS NULL', [r.reset_id]);
      if (!claimed.rowCount) throw new ApiError(410, 'PASSWORD_RESET_EXPIRED', 'Reset link used or expired');
      await c.query('UPDATE users SET password_hash = $2, must_change_password = false, password_expires_at = NULL WHERE id = $1', [r.user_id, hash]);
      await c.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [r.user_id]);
      await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [r.user_id]);
      return { data: { changed: true } };
    });
  }

  @Post('auth/logout')
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    await this.db.tx((c) => c.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(bearer(req))]));
    res.status(204);
  }

  @Post('auth/password')
  @HttpCode(200)
  async changePassword(@Req() req: FastifyRequest, @Body() raw: unknown) {
    const b = parse(z.object({ current_password: z.string().max(200), new_password: password }), raw);
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ALL, { allowStaff: true, passwordChange: true });
      const { rows: [row] } = await c.query('SELECT * FROM auth_login($1)', [u.email]);
      if (!(await verifyPassword(b.current_password, row?.password_hash))) throw new ApiError(422, 'VALIDATION_FAILED', 'Current password is wrong', { fields: ['current_password'] });
      if (b.new_password === b.current_password) throw new ApiError(422, 'VALIDATION_FAILED', 'Choose a password different from the current one', { fields: ['new_password'] });
      await c.query('UPDATE users SET password_hash = $2, must_change_password = false, password_expires_at = NULL WHERE id = $1', [u.id, await hashPassword(b.new_password)]);
      await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [u.id, u.session_id]);
      return { data: { changed: true } };
    });
  }

  @Get('me')
  async getMe(@Req() req: FastifyRequest) {
    return this.db.tx(async (c) => ({ data: await me(c, await portalUser(c, req, ALL, { allowStaff: true, passwordChange: true })) }));
  }

  @Post('invitations/lookup')
  @HttpCode(200)
  async lookup(@Body() raw: unknown) {
    const b = parse(z.object({ token: z.string().min(1).max(200) }), raw);
    return this.db.tx(async (c) => {
      const inv = await this.invitation(c, b.token);
      const { rows: [co] } = await c.query('SELECT name FROM companies WHERE id = $1', [inv.company_id]);
      return { data: { email: inv.email, role: inv.role, company_name: co?.name ?? null } };
    });
  }

  @Post('invitations/accept')
  async accept(@Body() raw: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    const b = parse(z.object({ token: z.string().min(1).max(200), name: z.string().trim().min(1).max(100), password }), raw);
    const hash = await hashPassword(b.password);
    return this.db.tx(async (c) => {
      const inv = await this.invitation(c, b.token);
      // Serialise with a concurrent revoke or accept of the same invitation.
      const open = await c.query('SELECT 1 FROM invitations WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE', [inv.invitation_id]);
      if (!open.rowCount) throw new ApiError(410, 'INVITATION_EXPIRED', 'Invitation no longer valid');
      if ((await c.query('SELECT email_has_user($1) AS taken', [inv.email])).rows[0].taken) throw new ApiError(409, 'CONFLICT', 'An account with this email exists');
      const { rows: [u] } = await c.query(
        'INSERT INTO users (email, name, role, company_id, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [inv.email, b.name, inv.role, inv.company_id, hash],
      );
      await c.query('UPDATE invitations SET accepted_at = now() WHERE id = $1', [inv.invitation_id]);
      res.status(201);
      const user = await me(c, { id: u.id, email: inv.email, name: b.name, role: inv.role, company_id: inv.company_id, session_id: '' });
      if (!inv.company_id) return { data: { user } }; // staff: no session, they sign in with their password
      return { data: { ...(await newSession(c, u.id)), user } };
    });
  }

  // Company invitations bind the tenant; staff invitations (no company) run in staff scope.
  private async invitation(c: Tx, t: string) {
    const { rows: [inv] } = await c.query('SELECT * FROM auth_invitation($1)', [sha256(t)]);
    if (!inv) throw new ApiError(404, 'INVITATION_INVALID', 'Invitation not found');
    if (!inv.usable) throw new ApiError(410, 'INVITATION_EXPIRED', 'Invitation no longer valid');
    if (inv.company_id) await c.tenant(inv.company_id);
    else await c.query("SELECT set_config('app.scope', 'staff', true)");
    return inv;
  }

  // ------------------------------------------------------------ team

  @Get('team')
  async team(@Req() req: FastifyRequest) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      const [users, invitations] = await Promise.all([
        c.query('SELECT id, name, email, role, created_at FROM users WHERE disabled_at IS NULL ORDER BY name'),
        c.query('SELECT id, email, role, created_at, expires_at FROM invitations WHERE accepted_at IS NULL AND revoked_at IS NULL ORDER BY created_at'),
      ]);
      return { data: { users: users.rows, invitations: invitations.rows } };
    });
  }

  @Post('team/invitations')
  async invite(@Req() req: FastifyRequest, @Body() raw: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN);
      const b = parse(z.object({ email, role: companyRole }), raw);
      if ((await c.query('SELECT email_has_user($1) AS taken', [b.email])).rows[0].taken) throw new ApiError(409, 'CONFLICT', 'This email already has an account');
      const t = token('wbi_');
      const { rows: [inv] } = await c.query( // invitations_one_open → 23505 → 409 CONFLICT
        `INSERT INTO invitations (company_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) RETURNING id, email, role, expires_at`,
        [u.company_id, b.email, b.role, sha256(t), u.id, INVITATION_DAYS],
      );
      await mailInvitation(c, t, b.email, b.role);
      res.status(201);
      return { data: inv };
    });
  }

  @Post('team/invitations/:id/resend')
  @HttpCode(200)
  async resend(@Req() req: FastifyRequest, @Param('id') id: string) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      const inv = await this.ownInvitation(c, id);
      if (inv.accepted_at || inv.revoked_at) throw new ApiError(409, 'CONFLICT', 'Invitation is not open');
      const t = token('wbi_');
      const { rows: [row] } = await c.query(
        `UPDATE invitations SET token_hash = $2, expires_at = now() + make_interval(days => $3) WHERE id = $1
         RETURNING id, email, role, expires_at`,
        [inv.id, sha256(t), INVITATION_DAYS],
      );
      await mailInvitation(c, t, row.email, row.role);
      return { data: row };
    });
  }

  @Delete('team/invitations/:id')
  async revoke(@Req() req: FastifyRequest, @Param('id') id: string, @Res({ passthrough: true }) res: FastifyReply) {
    await this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      const inv = await this.ownInvitation(c, id);
      if (inv.accepted_at) throw new ApiError(409, 'CONFLICT', 'Invitation already accepted');
      await c.query('UPDATE invitations SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1', [inv.id]);
    });
    res.status(204);
  }

  private async ownInvitation(c: Tx, id: string) {
    const { rows: [inv] } = await c.query('SELECT id, accepted_at, revoked_at FROM invitations WHERE id = $1 FOR UPDATE', [idOrNone(id)]);
    if (!inv) throw new ApiError(404, 'NOT_FOUND', 'Invitation not found');
    return inv;
  }

  @Patch('team/users/:id')
  async changeRole(@Req() req: FastifyRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      const b = parse(z.object({ role: companyRole }), raw);
      const target = await this.ownUser(c, id);
      if (target.role === 'company_admin' && b.role !== 'company_admin') await assertAnotherAdmin(c, target.id);
      if (target.role === 'manager' && b.role !== 'manager') await c.query('UPDATE employees SET manager_user_id = NULL WHERE manager_user_id = $1', [target.id]);
      const { rows: [row] } = await c.query('UPDATE users SET role = $2 WHERE id = $1 RETURNING id, name, email, role, created_at', [target.id, b.role]);
      return { data: row };
    });
  }

  @Delete('team/users/:id')
  async removeUser(@Req() req: FastifyRequest, @Param('id') id: string, @Res({ passthrough: true }) res: FastifyReply) {
    await this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      const target = await this.ownUser(c, id);
      if (target.role === 'company_admin') await assertAnotherAdmin(c, target.id);
      if (target.role === 'manager') await c.query('UPDATE employees SET manager_user_id = NULL WHERE manager_user_id = $1', [target.id]);
      await c.query('UPDATE users SET disabled_at = now() WHERE id = $1', [target.id]);
      await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [target.id]);
    });
    res.status(204);
  }

  private async ownUser(c: Tx, id: string) {
    const { rows: [u] } = await c.query('SELECT id, role FROM users WHERE id = $1 AND disabled_at IS NULL FOR UPDATE', [idOrNone(id)]);
    if (!u) throw new ApiError(404, 'NOT_FOUND', 'User not found');
    return u;
  }
}
