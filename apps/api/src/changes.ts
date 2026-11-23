// Maker-checker (change-approvals; product owner 17 and 19 Nov 2026). A member's write, and a Company
// Admin's write while the company has another Company Admin, runs exactly as it would, so every
// 400/404/409/422 comes back at once, but its transaction is rolled back and the request is stored as
// a pending change. Approving replays the stored request as the approving Company Admin, who is never
// the one who asked (portal/changes.controller.ts).
import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { ApiError, config, Tx } from './core';
import { sendMail } from './mail';

type Resource = 'employee' | 'employee_import' | 'monitoring_settings' | 'pause' | 'device' | 'alert' | 'block_rule' | 'sensitive_domain' | 'productivity_rule'
  | 'invitation' | 'user' | 'role' | 'company_settings' | 'deployment';
type Ctx = { c: Tx; params: Record<string, string>; body: any; result: any };
type Spec = { resource: Resource; action: string; target?: (x: Ctx) => string | null; summary: (x: Ctx) => Promise<string> };

const one = async (c: Tx, sql: string, id: string) => (await c.query(sql, [id])).rows[0] ?? {};
const emp = (x: Ctx) => one(x.c, 'SELECT name FROM employees WHERE id = $1', x.params.id).then((r) => r.name ?? 'an employee');
const host = (x: Ctx) => one(x.c, 'SELECT hostname FROM devices WHERE id = $1', x.params.id).then((r) => r.hostname ?? 'a computer');
const rule = (table: string) => (x: Ctx) => one(x.c, `SELECT pattern FROM ${table} WHERE id = $1`, x.params.id).then((r) => r.pattern ?? 'a rule');
const id = (x: Ctx) => x.params.id ?? null;
const person = (x: Ctx) => one(x.c, 'SELECT name FROM users WHERE id = $1', x.params.id).then((r) => r.name ?? 'a user');
const roleName = async (x: Ctx, roleId: string | undefined) =>
  roleId ? (await one(x.c, 'SELECT name FROM roles WHERE id = $1', roleId)).name ?? 'a role' : 'Company Admin';
const invitee = (x: Ctx) => one(x.c, 'SELECT email FROM invitations WHERE id = $1', x.params.id).then((r) => r.email ?? 'someone');
const CATEGORY: Record<string, string> = { productive: 'productive', neutral: 'neutral', unproductive: 'unproductive' };

// Keyed by `${method} ${route}`; only these routes become changes.
const APPROVAL: Record<string, Spec> = {
  'POST /v1/employees': { resource: 'employee', action: 'create', summary: async (x) => `Add employee ${x.body?.name} (${x.body?.email})` },
  'POST /v1/employees/import': { resource: 'employee_import', action: 'import',
    summary: async (x) => `Import ${x.result?.data?.created ?? 0} employees from a CSV file` },
  'POST /v1/employees/:id/restore': { resource: 'employee', action: 'restore', target: id, summary: async (x) => `Restore employee ${await emp(x)}` },
  'PATCH /v1/employees/:id': { resource: 'employee', action: 'update', target: id, summary: async (x) => `Change the details of ${await emp(x)}` },
  'DELETE /v1/employees/:id': { resource: 'employee', action: 'delete', target: id, summary: async (x) => `Archive employee ${await emp(x)}` },
  'PUT /v1/employees/:id/monitoring-settings': { resource: 'monitoring_settings', action: 'update', target: id,
    summary: async (x) => `Change what is monitored for ${await emp(x)}` },
  'POST /v1/employees/:id/pauses': { resource: 'pause', action: 'create', target: id, summary: async (x) => `Pause monitoring of ${await emp(x)}` },
  'PATCH /v1/employees/:id/pauses/:pause_id': { resource: 'pause', action: 'update', target: (x) => x.params.pause_id,
    summary: async (x) => `Change the end of the monitoring pause of ${await emp(x)}` },
  'POST /v1/employees/:id/pauses/:pause_id/cancel': { resource: 'pause', action: 'cancel', target: (x) => x.params.pause_id,
    summary: async (x) => `End the monitoring pause of ${await emp(x)} now` },
  'POST /v1/devices/:id/release': { resource: 'device', action: 'release', target: id, summary: async (x) => `Release computer ${await host(x)}` },
  'POST /v1/devices/:id/deactivate': { resource: 'device', action: 'deactivate', target: id, summary: async (x) => `Deactivate computer ${await host(x)}` },
  'POST /v1/alerts/:id/resolve': { resource: 'alert', action: 'resolve', target: id,
    summary: async (x) => `Mark an alert on ${(await one(x.c, 'SELECT hostname FROM tamper_events WHERE id = $1', x.params.id)).hostname ?? 'a computer'} as resolved` },
  'POST /v1/block-rules': { resource: 'block_rule', action: 'create', summary: async (x) => `Block ${x.body?.type === 'domain' ? 'website ' : ''}${x.body?.pattern}` },
  'PATCH /v1/block-rules/:id': { resource: 'block_rule', action: 'update', target: id, summary: async (x) => `Change the block of ${await rule('block_rules')(x)}` },
  'DELETE /v1/block-rules/:id': { resource: 'block_rule', action: 'delete', target: id, summary: async (x) => `Unblock ${await rule('block_rules')(x)}` },
  'POST /v1/sensitive-domains': { resource: 'sensitive_domain', action: 'create', summary: async (x) => `Make ${x.body?.pattern} a private site` },
  'DELETE /v1/sensitive-domains/:id': { resource: 'sensitive_domain', action: 'delete', target: id,
    summary: async (x) => `Stop treating ${await rule('sensitive_domains')(x)} as a private site` },
  'POST /v1/productivity-rules': { resource: 'productivity_rule', action: 'create',
    summary: async (x) => `Count ${x.body?.pattern} as ${CATEGORY[x.body?.category] ?? 'a category'}` },
  'PATCH /v1/productivity-rules/:id': { resource: 'productivity_rule', action: 'update', target: id,
    summary: async (x) => `Change how ${await rule('productivity_rules')(x)} is counted` },
  'DELETE /v1/productivity-rules/:id': { resource: 'productivity_rule', action: 'delete', target: id,
    summary: async (x) => `Remove the productivity rule for ${await rule('productivity_rules')(x)}` },
  'POST /v1/team/invitations': { resource: 'invitation', action: 'create',
    summary: async (x) => `Invite ${x.body?.email} as ${await roleName(x, x.body?.role === 'company_admin' ? undefined : x.body?.role_id)}` },
  'POST /v1/team/invitations/:id/resend': { resource: 'invitation', action: 'resend', target: id, summary: async (x) => `Send the invitation to ${await invitee(x)} again` },
  'DELETE /v1/team/invitations/:id': { resource: 'invitation', action: 'delete', target: id, summary: async (x) => `Cancel the invitation to ${await invitee(x)}` },
  'PATCH /v1/team/users/:id': { resource: 'user', action: 'update', target: id,
    summary: async (x) => `Make ${await person(x)} ${await roleName(x, x.body?.role === 'company_admin' ? undefined : x.body?.role_id)}` },
  'DELETE /v1/team/users/:id': { resource: 'user', action: 'delete', target: id, summary: async (x) => `Remove ${await person(x)} from the team` },
  'PATCH /v1/company/settings': { resource: 'company_settings', action: 'update', summary: async () => 'Change the company settings' },
  'PUT /v1/deployment/min-agent-version': { resource: 'deployment', action: 'update',
    summary: async (x) => (x.body?.min_agent_version ? `Require agent version ${x.body.min_agent_version} or later` : 'Stop requiring a minimum agent version') },
  'POST /v1/roles': { resource: 'role', action: 'create', summary: async (x) => `Create the role ${x.body?.name}` },
  'PATCH /v1/roles/:id': { resource: 'role', action: 'update', target: id, summary: async (x) => `Change the role ${await roleName(x, x.params.id)}` },
  'DELETE /v1/roles/:id': { resource: 'role', action: 'delete', target: id, summary: async (x) => `Delete the role ${await roleName(x, x.params.id)}` },
};

export const isApprovalRoute = (req: FastifyRequest) => !!APPROVAL[`${req.method} ${req.routeOptions.url}`];

// An approved change's replay carries this per-process secret, so it runs instead of waiting again.
const REPLAY = randomBytes(32).toString('hex');
export const isReplay = (req: FastifyRequest) => req.headers['x-workbeat-replay'] === REPLAY;

// 202 with the pending change, sent through the error filter so every handler stays unchanged.
export class Accepted extends ApiError {
  constructor(public change: unknown) { super(202, 'PENDING_APPROVAL', 'Waiting for approval'); }
  body() { return { data: { change: this.change } }; }
}

const NOTIFY_MINUTES = 15;
export const CHANGE = `ch.id, ch.status, ch.resource, ch.action, ch.target_id, ch.summary,
  json_build_object('id', rq.id, 'name', rq.name) AS requested_by, ch.requested_at,
  CASE WHEN dc.id IS NULL THEN NULL ELSE json_build_object('id', dc.id, 'name', dc.name) END AS decided_by,
  ch.decided_at, ch.reason, ch.error
  FROM changes ch JOIN users rq ON rq.id = ch.requested_by LEFT JOIN users dc ON dc.id = ch.decided_by`;

// Called by portalUser for a write that waits for approval: Db.tx runs the handler, rolls it back,
// then calls this on the same connection to store the change.
export function deferAsChange(c: Tx, req: FastifyRequest, user: { id: string; company_id: string }) {
  const spec = APPROVAL[`${req.method} ${req.routeOptions.url}`];
  c.dryRun = async (result: unknown) => {
    await c.query('BEGIN');
    try {
      await c.tenant(user.company_id);
      const x: Ctx = { c, params: req.params as Record<string, string>, body: req.body, result };
      const body = typeof req.body === 'string' ? req.body : req.body === undefined ? null : JSON.stringify(req.body);
      const { rows: [{ recent }] } = await c.query(
        // requested_at bounds it on changes_company (notified_at is set at insert, so equal to requested_at).
        'SELECT EXISTS (SELECT 1 FROM changes WHERE company_id = app_company_id() AND requested_at > now() - make_interval(mins => $1) AND notified_at > now() - make_interval(mins => $1)) AS recent', [NOTIFY_MINUTES]);
      const { rows: [{ id: changeId }] } = await c.query(
        `INSERT INTO changes (company_id, resource, action, target_id, summary, method, path, content_type, body, requested_by, notified_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $11 THEN NULL ELSE now() END) RETURNING id`,
        [user.company_id, spec.resource, spec.action, spec.target?.(x) ?? null, (await spec.summary(x)).slice(0, 300), req.method, req.url,
         typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : null, body, user.id, recent],
      );
      const { rows: [change] } = await c.query(`SELECT ${CHANGE} WHERE ch.id = $1`, [changeId]);
      const admins = recent ? [] : (await c.query("SELECT email FROM users WHERE company_id = app_company_id() AND role = 'company_admin' AND disabled_at IS NULL AND id <> $1", [user.id])).rows;
      await c.query('COMMIT');
      for (const a of admins)
        void sendMail(a.email, 'A change is waiting for your approval in WorkBeat',
          `${change.requested_by.name} asked for a change in WorkBeat:\n\n${change.summary}\n\nReview it on the Approvals page: ${config().PORTAL_URL}/approvals`)
          .catch(() => console.error(JSON.stringify({ t: new Date(), level: 'error', err: 'change_email_failed' })));
      throw new Accepted(change);
    } catch (e) {
      if (!(e instanceof Accepted)) await c.query('ROLLBACK').catch(() => {});
      throw e;
    }
  };
}

// The one who asked hears how their change ended.
export function mailDecision(to: string | undefined, change: any) {
  if (!to) return;
  const what = { approved: 'was approved and applied', rejected: 'was rejected', failed: 'could not be applied' }[change.status as string];
  const extra = change.status === 'rejected' && change.reason ? `\n\nReason: ${change.reason}`
    : change.status === 'failed' ? `\n\nWhy: ${change.error?.message}` : '';
  void sendMail(to, `Your WorkBeat change ${what}`, `Your change "${change.summary}" ${what}.${extra}`)
    .catch(() => console.error(JSON.stringify({ t: new Date(), level: 'error', err: 'change_email_failed' })));
}

// Approval replays a stored request through the app itself (set in main.ts).
type Injected = { statusCode: number; body: string };
let injector: ((o: { method: string; url: string; headers: Record<string, string>; payload?: string }) => Promise<Injected>) | undefined;
export const setInjector = (f: typeof injector) => { injector = f; };
export function replay(o: { method: string; url: string; headers: Record<string, string>; payload?: string }) {
  if (!injector) throw new Error('injector not set');
  return injector({ ...o, headers: { ...o.headers, 'x-workbeat-replay': REPLAY } });
}
