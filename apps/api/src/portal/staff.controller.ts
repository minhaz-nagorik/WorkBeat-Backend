// Staff (super_admin) routes. Only MFA recovery so far; the rest of the staff API comes with
// administer-platform and staff-accounts.
import { Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { idOrNone, staffUser } from '../auth';
import { ApiError, Db } from '../core';

@Controller('v1/staff')
export class StaffController {
  constructor(@Inject(Db) private db: Db) {}

  // Another super_admin clears a lost factor; the target sets up a new one at their next sign-in.
  @Post('users/:id/mfa/reset')
  @HttpCode(200)
  async resetMfa(@Req() req: FastifyRequest, @Param('id') id: string) {
    return this.db.tx(async (c) => {
      const me = await staffUser(c, req);
      const { rows: [t] } = await c.query("SELECT id FROM users WHERE id = $1 AND role = 'super_admin' AND disabled_at IS NULL FOR UPDATE", [idOrNone(id)]);
      if (!t) throw new ApiError(404, 'NOT_FOUND', 'Staff member not found');
      if (t.id === me.id) throw new ApiError(409, 'CONFLICT', 'Ask another staff member to reset your factor');
      await c.query('UPDATE users SET mfa_secret_ciphertext = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL WHERE id = $1', [t.id]);
      await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [t.id]);
      await c.query('UPDATE mfa_challenges SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [t.id]);
      return { data: { id: t.id, mfa_enabled: false } };
    });
  }
}
