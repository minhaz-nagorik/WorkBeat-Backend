// Custom roles (0013): Company Admins name a role, pick the areas it may see or change, and whether it
// sees only its own team. Every write here is a change while the company has another Company Admin.
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ADMIN, idOrNone, PERMS, portalUser } from '../auth';
import { ApiError, Db, parse, Tx } from '../core';

const ROLE = `r.id, r.name, r.permissions, r.team_only, r.created_at,
  (SELECT count(*)::int FROM users u WHERE u.role_id = r.id AND u.disabled_at IS NULL) AS users`;
const body = z.object({
  name: z.string().trim().min(1).max(60),
  // An edit right brings its view right, so a role never changes what it cannot see.
  permissions: z.array(z.enum(PERMS)).max(PERMS.length)
    .transform((p) => [...new Set([...p, ...p.filter((x) => x.endsWith('.edit')).map((x) => x.replace('.edit', '.view'))])].sort()),
  team_only: z.boolean().default(false),
});
const taken = (e: any) => { if (e?.code === '23505') throw new ApiError(409, 'CONFLICT', 'A role with this name exists', { fields: ['name'] }); throw e; };

async function one(c: Tx, id: string, lock = false) {
  const { rows: [r] } = await c.query(`SELECT ${ROLE} FROM roles r WHERE r.id = $1${lock ? ' FOR UPDATE' : ''}`, [idOrNone(id)]);
  if (!r) throw new ApiError(404, 'NOT_FOUND', 'Role not found');
  return r;
}

@Controller('v1/roles')
export class RolesController {
  constructor(@Inject(Db) private db: Db) {}

  @Get()
  async list(@Req() req: FastifyRequest) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      return { data: (await c.query(`SELECT ${ROLE} FROM roles r WHERE r.company_id = app_company_id() ORDER BY lower(r.name)`)).rows };
    });
  }

  @Post()
  async create(@Req() req: FastifyRequest, @Body() raw: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN);
      const b = parse(body, raw, 422);
      const { rows: [r] } = await c.query('INSERT INTO roles (company_id, name, permissions, team_only) VALUES ($1, $2, $3, $4) RETURNING id',
        [u.company_id, b.name, b.permissions, b.team_only]).catch(taken);
      res.status(201);
      return { data: await one(c, r.id) };
    });
  }

  @Patch(':id')
  async update(@Req() req: FastifyRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      const b = parse(body, raw, 422);
      const r = await one(c, id, true);
      await c.query('UPDATE roles SET name = $2, permissions = $3, team_only = $4 WHERE id = $1', [r.id, b.name, b.permissions, b.team_only]).catch(taken);
      // No longer team-only: its users stop being anyone's manager.
      if (!b.team_only) await c.query('UPDATE employees SET manager_user_id = NULL WHERE company_id = app_company_id() AND manager_user_id IN (SELECT id FROM users WHERE role_id = $1)', [r.id]);
      return { data: await one(c, r.id) };
    });
  }

  // Only an unused role: its open invitations go with it, its users must move to another role first.
  @Delete(':id')
  async remove(@Req() req: FastifyRequest, @Param('id') id: string, @Res({ passthrough: true }) res: FastifyReply) {
    await this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      const r = await one(c, id, true);
      if (r.users) throw new ApiError(409, 'CONFLICT', 'Move this role’s users to another role first');
      await c.query('UPDATE users SET role_id = NULL WHERE role_id = $1 AND disabled_at IS NOT NULL', [r.id]); // removed users
      await c.query(`UPDATE companies SET alert_email = jsonb_set(alert_email, '{roles}',
        CASE WHEN (alert_email -> 'roles') - $1::text = '[]' THEN '["company_admin"]' ELSE (alert_email -> 'roles') - $1::text END) WHERE id = app_company_id()`, [r.id]);
      await c.query('DELETE FROM roles WHERE id = $1', [r.id]);
    });
    res.status(204);
  }
}
