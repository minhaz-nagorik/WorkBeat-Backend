// Portal sign-in: scrypt passwords and opaque session tokens (migration 0004).
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyRequest } from 'fastify';
import { ApiError, sha256, token, Tx } from './core';
import { deferAsChange, isApprovalRoute, isReplay } from './changes';
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

// Company Admin is the only fixed company role; every other user is a 'member' of a custom role (0013).
export type Role = 'company_admin' | 'member';
export const PERMS = ['reports', 'employees.view', 'employees.edit', 'devices.view', 'devices.edit', 'alerts.view', 'alerts.edit',
  'policy.view', 'policy.edit', 'deployment'] as const;
export type Perm = (typeof PERMS)[number];
// What a route needs: a permission, Company Admin ('admin'), any company user ('any'), or no company user ('none').
export type Need = Perm | 'admin' | 'any' | 'none';
export type User = {
  id: string; company_id: string; role: Role; email: string; name: string; session_id: string; must_change_password?: boolean;
  role_id?: string | null; role_name?: string | null; permissions: Perm[]; team_only: boolean;
};
export const ADMIN: Need = 'admin';
export const ALL: Need = 'any';
// Settings WorkBeat staff manage: every company role gets 403 (company name, retention, domain, notice, billing).
export const NO_COMPANY_ROLE: Need = 'none';
export const can = (u: Pick<User, 'role' | 'permissions'>, need: Need) =>
  need === 'any' || (need !== 'none' && (u.role === 'company_admin' || (need !== 'admin' && u.permissions.includes(need))));

export function bearer(req: FastifyRequest) {
  const a = req.headers.authorization;
  return typeof a === 'string' && a.startsWith('Bearer ') ? a.slice(7).trim() : '';
}

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const NO_ID = '00000000-0000-0000-0000-000000000000';
export const idOrNone = (v: string) => (isUuid(v) ? v : NO_ID); // a malformed path ID answers 404, not 500

// Role check before any data is read (role-access). super_admin never reaches company routes.
// passwordChange: the route stays open while a temporary password must be replaced (GET /v1/me, POST /v1/auth/password).
export async function portalUser(c: Tx, req: FastifyRequest, need: Need, opts: { allowStaff?: boolean; passwordChange?: boolean } = {}): Promise<User> {
  const t = bearer(req);
  const u = t ? (await c.query('SELECT * FROM auth_session($1)', [sha256(t)])).rows[0] : null;
  if (!u || (u.role !== 'super_admin' && !u.company_id)) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in required');
  const user: User = { id: u.user_id, company_id: u.company_id, role: u.role, email: u.email, name: u.name, session_id: u.session_id,
    must_change_password: u.must_change_password, role_id: u.role_id, role_name: u.role_name, permissions: u.permissions ?? [], team_only: !!u.team_only };
  if (u.must_change_password && !opts.passwordChange) throw new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'Choose a new password first');
  if (u.role === 'super_admin') {
    if (!opts.allowStaff) throw new ApiError(403, 'FORBIDDEN', 'Not allowed');
    await c.query("SELECT set_config('app.scope', 'staff', true)"); // staff never get tenant scope (D41)
    tag(req, { scope: 'staff' });
    return user;
  }
  if (!can(user, need)) throw new ApiError(403, 'FORBIDDEN', 'Not allowed for your role');
  const approval = isApprovalRoute(req) && !isReplay(req);
  // Safety net: a member's write runs only as a change, so a write missing from the approval list is refused.
  if (user.role === 'member' && req.method !== 'GET' && need !== 'any' && !approval && !isReplay(req))
    throw new ApiError(403, 'FORBIDDEN', 'Not allowed for your role');
  await c.tenant(u.company_id);
  // Maker-checker: a member always waits for a Company Admin; a Company Admin waits for another one when there is one.
  if (approval && (user.role === 'member' || await otherAdmins(c, user.id))) deferAsChange(c, req, user);
  tag(req, { company_id: u.company_id });
  return user;
}

// A user employees can be assigned to as their manager: enabled, in a team-only role.
export const TEAM_LEAD = "disabled_at IS NULL AND role_id IN (SELECT id FROM roles WHERE team_only)";

export const otherAdmins = async (c: Tx, userId: string) =>
  (await c.query("SELECT 1 FROM users WHERE role = 'company_admin' AND disabled_at IS NULL AND id <> $1 LIMIT 1", [userId])).rowCount! > 0;

// Staff routes: super_admin only, in staff scope.
export async function staffUser(c: Tx, req: FastifyRequest): Promise<User> {
  const t = bearer(req);
  const u = t ? (await c.query('SELECT * FROM auth_session($1)', [sha256(t)])).rows[0] : null;
  if (!u) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in required');
  if (u.role !== 'super_admin') throw new ApiError(403, 'FORBIDDEN', 'Staff only');
  return portalUser(c, req, 'none', { allowStaff: true });
}

// An employee the caller may see: own company (RLS), and own team for a team-only role. Else 404.
export async function employeeFor(c: Tx, u: User, id: string) {
  const { rows: [e] } = await c.query(
    `SELECT id, name, email, department, manager_user_id, archived_at FROM employees
      WHERE id = $1 AND (NOT $2 OR manager_user_id = $3)`,
    [idOrNone(id), u.team_only, u.id],
  );
  if (!e) throw new ApiError(404, 'NOT_FOUND', 'Employee not found');
  return e;
}

// Employee IDs the caller's totals cover (a team-only role: own team only); archived employees are left out (usage-reports, dashboard-summary).
export async function scopeEmployeeIds(c: Tx, u: User): Promise<string[]> {
  const { rows } = await c.query("SELECT id FROM employees WHERE (NOT $1 OR manager_user_id = $2) AND archived_at IS NULL", [u.team_only, u.id]);
  return rows.map((r) => r.id);
}
