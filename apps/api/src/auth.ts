// Portal sign-in: scrypt passwords and opaque session tokens (migration 0004).
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyRequest } from 'fastify';
import { ApiError, sha256, token, Tx } from './core';
import { tag } from './http';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_DAYS = 7;
export const INVITATION_DAYS = 7;

export async function hashPassword(pw: string) {
  const salt = randomBytes(16);
  const h = await scryptAsync(pw, salt, 64, SCRYPT);
  return ['scrypt', salt.toString('base64'), h.toString('base64')].join('$');
}

const DUMMY = ['scrypt', Buffer.alloc(16).toString('base64'), Buffer.alloc(64).toString('base64')].join('$');
// Always runs scrypt, so an unknown email takes as long as a wrong password.
export async function verifyPassword(pw: string, stored: string | null | undefined) {
  const [, salt, hash] = (stored ?? DUMMY).split('$');
  const want = Buffer.from(hash ?? '', 'base64');
  const got = await scryptAsync(pw, Buffer.from(salt ?? '', 'base64'), 64, SCRYPT);
  return !!stored && want.length === got.length && timingSafeEqual(want, got);
}

export async function newSession(c: Tx, userId: string) {
  const t = token('wbs_');
  const { rows: [s] } = await c.query(
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(days => $3)) RETURNING expires_at',
    [userId, sha256(t), SESSION_DAYS],
  );
  return { token: t, expires_at: s.expires_at };
}

export type Role = 'company_admin' | 'manager' | 'it_admin';
export type User = { id: string; company_id: string; role: Role; email: string; name: string; session_id: string };
export const ADMIN: Role[] = ['company_admin'];
export const ADMIN_IT: Role[] = ['company_admin', 'it_admin'];
export const ADMIN_MANAGER: Role[] = ['company_admin', 'manager'];
export const ALL: Role[] = ['company_admin', 'manager', 'it_admin'];

export function bearer(req: FastifyRequest) {
  const a = req.headers.authorization;
  return typeof a === 'string' && a.startsWith('Bearer ') ? a.slice(7).trim() : '';
}

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const NO_ID = '00000000-0000-0000-0000-000000000000';
export const idOrNone = (v: string) => (isUuid(v) ? v : NO_ID); // a malformed path ID answers 404, not 500

// Role check before any data is read (role-access). super_admin never reaches company routes.
export async function portalUser(c: Tx, req: FastifyRequest, roles: Role[], opts: { allowStaff?: boolean } = {}): Promise<User> {
  const t = bearer(req);
  const u = t ? (await c.query('SELECT * FROM auth_session($1)', [sha256(t)])).rows[0] : null;
  if (!u || (u.role !== 'super_admin' && !u.company_id)) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in required');
  const user: User = { id: u.user_id, company_id: u.company_id, role: u.role, email: u.email, name: u.name, session_id: u.session_id };
  if (u.role === 'super_admin') {
    if (!opts.allowStaff) throw new ApiError(403, 'FORBIDDEN', 'Not allowed');
    await c.query("SELECT set_config('app.scope', 'staff', true)"); // staff never get tenant scope (D41)
    tag(req, { scope: 'staff' });
    return user;
  }
  if (!roles.includes(u.role)) throw new ApiError(403, 'FORBIDDEN', 'Not allowed for your role');
  await c.tenant(u.company_id);
  tag(req, { company_id: u.company_id });
  return user;
}

// Staff routes: super_admin only, in staff scope. A staff session exists only after MFA (0005).
export async function staffUser(c: Tx, req: FastifyRequest): Promise<User> {
  const t = bearer(req);
  const u = t ? (await c.query('SELECT * FROM auth_session($1)', [sha256(t)])).rows[0] : null;
  if (!u) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in required');
  if (u.role !== 'super_admin') throw new ApiError(403, 'FORBIDDEN', 'Staff only');
  return portalUser(c, req, [], { allowStaff: true });
}

// An employee the caller may see: own company (RLS), and own team for a manager. Else 404.
export async function employeeFor(c: Tx, u: User, id: string) {
  const { rows: [e] } = await c.query(
    `SELECT id, name, email, department, manager_user_id, archived_at FROM employees
      WHERE id = $1 AND ($2 <> 'manager' OR manager_user_id = $3)`,
    [idOrNone(id), u.role, u.id],
  );
  if (!e) throw new ApiError(404, 'NOT_FOUND', 'Employee not found');
  return e;
}

// Employee IDs the caller's scope covers (a manager: own team only).
export async function scopeEmployeeIds(c: Tx, u: User): Promise<string[]> {
  const { rows } = await c.query("SELECT id FROM employees WHERE $1 <> 'manager' OR manager_user_id = $2", [u.role, u.id]);
  return rows.map((r) => r.id);
}
