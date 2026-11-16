// Sign-in, invitations and the team (authenticate-users). Own auth replaces Supabase Auth (0004).
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ADMIN, ALL, bearer, hashPassword, idOrNone, INVITATION_DAYS, newSession, portalUser, User, verifyPassword } from '../auth';
import { ApiError, config, Db, decrypt, encrypt, parse, sha256, token, Tx } from '../core';
import { sendMail } from '../mail';
import { newSecret, otpauthUri, verifyTotp } from '../totp';

const MFA_CHALLENGE_MINUTES = 10;
const MFA_MAX_ATTEMPTS = 5;
const RESET_MINUTES = 30;

const password = z.string().min(10).max(200);
const email = z.string().trim().toLowerCase().email().max(254);
const companyRole = z.enum(['company_admin', 'manager', 'it_admin']);

async function me(c: Tx, u: User) {
  const company = u.company_id
    ? (await c.query('SELECT id, name, slug, status, timezone FROM companies WHERE id = $1', [u.company_id])).rows[0] ?? null
    : null;
  return { id: u.id, email: u.email, name: u.name, role: u.role, company };
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
      if (!(await verifyPassword(b.password, u?.password_hash)) || (u.role !== 'super_admin' && !u.company_id))
        throw new ApiError(401, 'UNAUTHENTICATED', 'Wrong email or password');
      if (u.role === 'super_admin') { // staff: no session until the second factor (D41)
        const t = token('wbm_');
        const { rows: [ch] } = await c.query(
          'INSERT INTO mfa_challenges (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3)) RETURNING expires_at',
          [u.user_id, sha256(t), MFA_CHALLENGE_MINUTES],
        );
        return { data: { mfa_required: true, mfa_enrolled: u.mfa_enabled, mfa_token: t, expires_at: ch.expires_at } };
      }
      return { data: { mfa_required: false, ...(await this.session(c, u.user_id)) } };
    });
  }

  private async session(c: Tx, userId: string) {
    const s = await newSession(c, userId);
    const { rows: [full] } = await c.query('SELECT * FROM auth_session($1)', [sha256(s.token)]);
    return { ...s, user: await me(c, { ...full, id: full.user_id }) };
  }

  // ------------------------------------------------------------ staff MFA (TOTP)

  // Starts or restarts enrolment for a staff member without a factor: returns the secret once.
  @Post('auth/mfa/enroll')
  @HttpCode(200)
  async mfaEnroll(@Body() raw: unknown) {
    const b = parse(z.object({ mfa_token: z.string().min(1).max(200) }), raw);
    return this.db.tx(async (c) => {
      const ch = await this.challenge(c, b.mfa_token);
      const { rows: [u] } = await c.query('SELECT email, mfa_enabled_at FROM users WHERE id = $1', [ch.user_id]);
      if (u.mfa_enabled_at) throw new ApiError(409, 'CONFLICT', 'A second factor is already set up');
      const secret = newSecret();
      await c.query('UPDATE mfa_challenges SET pending_secret_ciphertext = $2 WHERE id = $1', [ch.challenge_id, encrypt(secret, config().SECRETS_ENCRYPTION_KEY)]);
      return { data: { secret, otpauth_uri: otpauthUri(secret, u.email) } };
    });
  }

  // Checks a code: confirms a pending enrolment or signs in with the existing factor.
  @Post('auth/mfa/verify')
  @HttpCode(200)
  async mfaVerify(@Body() raw: unknown) {
    const b = parse(z.object({ mfa_token: z.string().min(1).max(200), code: z.string().trim().max(10) }), raw);
    const key = config().SECRETS_ENCRYPTION_KEY;
    const out = await this.db.tx(async (c) => {
      const ch = await this.challenge(c, b.mfa_token);
      const { rows: [m] } = await c.query('SELECT attempts, pending_secret_ciphertext FROM mfa_challenges WHERE id = $1 FOR UPDATE', [ch.challenge_id]);
      if (m.attempts >= MFA_MAX_ATTEMPTS) throw new ApiError(401, 'UNAUTHENTICATED', 'Too many wrong codes; sign in again');
      const { rows: [u] } = await c.query('SELECT mfa_secret_ciphertext, mfa_last_step FROM users WHERE id = $1 FOR UPDATE', [ch.user_id]);
      const blob = m.pending_secret_ciphertext ?? u.mfa_secret_ciphertext;
      if (!blob) throw new ApiError(409, 'CONFLICT', 'Set up a second factor first (POST /v1/auth/mfa/enroll)');
      const secret = decrypt(blob, key);
      const step = verifyTotp(secret, b.code, m.pending_secret_ciphertext ? null : u.mfa_last_step);
      if (step === null) {
        await c.query('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE id = $1', [ch.challenge_id]);
        return { error: new ApiError(401, 'MFA_CODE_INVALID', 'Wrong or expired code', { attempts_left: MFA_MAX_ATTEMPTS - m.attempts - 1 }) };
      }
      if (m.pending_secret_ciphertext)
        await c.query('UPDATE users SET mfa_secret_ciphertext = $2, mfa_enabled_at = now() WHERE id = $1', [ch.user_id, m.pending_secret_ciphertext]);
      await c.query('UPDATE users SET mfa_last_step = $2 WHERE id = $1', [ch.user_id, step]);
      await c.query('UPDATE mfa_challenges SET used_at = now() WHERE id = $1', [ch.challenge_id]);
      return { data: await this.session(c, ch.user_id) };
    });
    if (out.error) throw out.error; // after commit, so the failed attempt counts
    return { data: out.data };
  }

  private async challenge(c: Tx, t: string) {
    const { rows: [ch] } = await c.query('SELECT * FROM auth_mfa_challenge($1)', [sha256(t)]);
    if (!ch) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in again');
    await c.query("SELECT set_config('app.scope', 'staff', true)"); // challenges exist only for super_admin
    return ch;
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
      await c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [r.user_id, hash]);
      await c.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [r.user_id]);
      await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [r.user_id]);
      await c.query('UPDATE mfa_challenges SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [r.user_id]);
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
      const u = await portalUser(c, req, ALL, { allowStaff: true });
      const { rows: [row] } = await c.query('SELECT * FROM auth_login($1)', [u.email]);
      if (!(await verifyPassword(b.current_password, row?.password_hash))) throw new ApiError(422, 'VALIDATION_FAILED', 'Current password is wrong', { fields: ['current_password'] });
      await c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [u.id, await hashPassword(b.new_password)]);
      await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [u.id, u.session_id]);
      return { data: { changed: true } };
    });
  }

  @Get('me')
  async getMe(@Req() req: FastifyRequest) {
    return this.db.tx(async (c) => ({ data: await me(c, await portalUser(c, req, ALL, { allowStaff: true })) }));
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
      const s = await newSession(c, u.id);
      res.status(201);
      return { data: { ...s, user: await me(c, { id: u.id, email: inv.email, name: b.name, role: inv.role, company_id: inv.company_id, session_id: '' }) } };
    });
  }

  // Company invitations only; staff invitations belong to the staff API (not built yet).
  private async invitation(c: Tx, t: string) {
    const { rows: [inv] } = await c.query('SELECT * FROM auth_invitation($1)', [sha256(t)]);
    if (!inv || !inv.company_id) throw new ApiError(404, 'INVITATION_INVALID', 'Invitation not found');
    if (!inv.usable) throw new ApiError(410, 'INVITATION_EXPIRED', 'Invitation no longer valid');
    await c.tenant(inv.company_id);
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
