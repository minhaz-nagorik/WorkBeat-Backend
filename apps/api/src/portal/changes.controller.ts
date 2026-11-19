// Approvals page (change-approvals): Company Admins decide on the changes others asked for; everyone sees their own.
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ADMIN, ALL, bearer, idOrNone, otherAdmins, portalUser, User } from '../auth';
import { CHANGE, mailDecision, replay } from '../changes';
import { ApiError, Db, parse, Tx } from '../core';

const LIST_MAX = 500;
const STATUS = z.enum(['pending', 'approved', 'rejected', 'cancelled', 'failed']);
const RESOURCE = z.enum(['employee', 'employee_import', 'monitoring_settings', 'pause', 'device', 'alert', 'block_rule', 'sensitive_domain', 'productivity_rule',
  'invitation', 'user', 'role', 'company_settings', 'deployment']);

const read = async (c: Tx, id: string) => (await c.query(`SELECT ${CHANGE} WHERE ch.id = $1`, [id])).rows[0];

async function lockPending(c: Tx, id: string, extra = 'true', params: unknown[] = []) {
  const { rows: [ch] } = await c.query(`SELECT * FROM changes WHERE id = $1 AND ${extra} FOR UPDATE`, [idOrNone(id), ...params]);
  if (!ch) throw new ApiError(404, 'NOT_FOUND', 'Change not found');
  if (ch.status !== 'pending') throw new ApiError(409, 'CONFLICT', 'This change was already decided');
  return ch;
}

// The checker is never the maker, unless the maker is now the only Company Admin left (else it waits forever).
async function assertChecker(c: Tx, u: User, ch: { requested_by: string }) {
  if (ch.requested_by === u.id && await otherAdmins(c, u.id))
    throw new ApiError(403, 'FORBIDDEN', 'Another Company Admin must decide on your own change');
}

const requesterEmail = async (c: Tx, userId: string) =>
  (await c.query('SELECT email FROM users WHERE id = $1 AND disabled_at IS NULL', [userId])).rows[0]?.email as string | undefined;

@Controller('v1/changes')
export class ChangesController {
  constructor(@Inject(Db) private db: Db) {}

  @Get()
  async list(@Req() req: FastifyRequest, @Query() q: Record<string, string>) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ALL);
      const f = parse(z.object({ status: STATUS.optional(), resource: RESOURCE.optional() }), q, 422);
      const { rows } = await c.query(
        `SELECT ${CHANGE} WHERE ($1::text IS NULL OR ch.status = $1) AND ($2::text IS NULL OR ch.resource = $2)
           AND ($3 = 'company_admin' OR ch.requested_by = $4) ORDER BY ch.requested_at DESC, ch.id LIMIT $5`,
        [f.status ?? null, f.resource ?? null, u.role, u.id, LIST_MAX],
      );
      return { data: rows };
    });
  }

  // Replays the stored request as the approving admin while the change row stays locked, so two
  // admins cannot apply it twice. shortcut: the replay commits in its own transaction; a crash
  // between that commit and this one leaves an applied change marked pending.
  @Post(':id/approve')
  @HttpCode(200)
  async approve(@Req() req: FastifyRequest) {
    const id = (req.params as { id: string }).id;
    const { change, to } = await this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN);
      const ch = await lockPending(c, id);
      await assertChecker(c, u, ch);
      const r = await replay({
        method: ch.method, url: ch.path, payload: ch.body ?? undefined,
        headers: { authorization: `Bearer ${bearer(req)}`, ...(ch.content_type ? { 'content-type': ch.content_type } : {}) },
      });
      let error: { code: string; message: string } | null = null;
      if (r.statusCode >= 300) {
        let b: any = {};
        try { b = JSON.parse(r.body); } catch { /* keep {} */ }
        error = { code: b.code ?? 'INTERNAL', message: b.error ?? 'The change could not be applied' };
      }
      await c.query("UPDATE changes SET status = $2, decided_by = $3, decided_at = now(), error = $4 WHERE id = $1",
        [ch.id, error ? 'failed' : 'approved', u.id, error ? JSON.stringify(error) : null]);
      return { change: await read(c, ch.id), to: await requesterEmail(c, ch.requested_by) };
    });
    mailDecision(to, change);
    return { data: { change } };
  }

  @Post(':id/reject')
  @HttpCode(200)
  async reject(@Req() req: FastifyRequest, @Param('id') id: string, @Body() raw: unknown) {
    const { change, to } = await this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN);
      const b = parse(z.object({ reason: z.string().trim().max(500).nullable().optional() }), raw ?? {}, 422);
      const ch = await lockPending(c, id);
      await assertChecker(c, u, ch);
      await c.query("UPDATE changes SET status = 'rejected', decided_by = $2, decided_at = now(), reason = $3 WHERE id = $1", [ch.id, u.id, b.reason || null]);
      return { change: await read(c, ch.id), to: await requesterEmail(c, ch.requested_by) };
    });
    mailDecision(to, change);
    return { data: { change } };
  }

  // Only the one who asked, while it is pending.
  @Delete(':id')
  async cancel(@Req() req: FastifyRequest, @Param('id') id: string, @Res({ passthrough: true }) res: FastifyReply) {
    await this.db.tx(async (c) => {
      const u = await portalUser(c, req, ALL);
      const ch = await lockPending(c, id, 'requested_by = $2', [u.id]);
      await c.query("UPDATE changes SET status = 'cancelled', decided_at = now() WHERE id = $1", [ch.id]);
    });
    res.status(204);
  }
}
