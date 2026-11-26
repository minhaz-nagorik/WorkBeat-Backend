// End-to-end check of the portal API against a running local API.
// Usage: ADMIN_EMAIL=… ADMIN_PASSWORD=… [STAFF1_EMAIL=… STAFF1_PASSWORD=… STAFF_TARGET_SLUG=…]
//        [CRON_SECRET=…] [BASE_URL=http://localhost:3000] pnpm smoke:portal
// Reads invitation emails from STORAGE_DIR/outbox, so run it against a local API without RESEND_API_KEY.
// Writes test users, employees, rules and one device into the admin's company.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const OUTBOX = join(process.env.STORAGE_DIR ?? './storage', 'outbox');
const run = Date.now().toString(36);

async function call(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined && typeof body !== 'string') h['content-type'] = 'application/json';
  let r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  if (r.status === 429) { // sign-in routes are limited per IP: wait as told, then retry once
    await new Promise((ok) => setTimeout(ok, (Number(r.headers.get('retry-after')) || 60) * 1000 + 500));
    r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  }
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json, headers: r.headers };
}
const ok = (name: string) => console.log('ok', name);
function expect(r: { status: number; json: any }, status: number, code?: string) {
  assert.equal(r.status, status, `${status} expected, got ${r.status} ${JSON.stringify(r.json)}`);
  if (code) assert.equal(r.json.code, code);
  return r.json?.data;
}
function inviteToken(email: string) {
  const f = readdirSync(OUTBOX).filter((n) => n.includes(email)).sort().pop();
  assert.ok(f, 'invitation email in outbox for ' + email);
  return /token=([^\s&]+)/.exec(JSON.parse(readFileSync(join(OUTBOX, f), 'utf8')).text)![1];
}
// roleId: a custom role's id, or null for a Company Admin.
async function join_(admin: string, roleId: string | null, tag: string) {
  const email = `${tag}-${run}@example.test`;
  expect(await call('POST', '/v1/team/invitations', admin, roleId ? { email, role: 'member', role_id: roleId } : { email, role: 'company_admin' }), 201);
  const t = decodeURIComponent(inviteToken(email));
  const look = expect(await call('POST', '/v1/invitations/lookup', undefined, { token: t }), 200);
  assert.equal(look.role, roleId ? 'member' : 'company_admin');
  const role = tag;
  const acc = expect(await call('POST', '/v1/invitations/accept', undefined, { token: t, name: `Test ${role}`, password: 'correct horse battery' }), 201);
  expect(await call('POST', '/v1/invitations/accept', undefined, { token: t, name: 'x', password: 'correct horse battery' }), 410, 'INVITATION_EXPIRED');
  return { token: acc.token as string, id: acc.user.id as string, email };
}

// Staff sign-in. Needs STAFF1_EMAIL/STAFF1_PASSWORD of a test super_admin (pnpm seed -- --staff-email …).
async function staff() {
  const l = expect(await call('POST', '/v1/auth/login', undefined, { email: process.env.STAFF1_EMAIL, password: process.env.STAFF1_PASSWORD }), 200);
  const me = expect(await call('GET', '/v1/me', l.token), 200);
  assert.equal(me.role, 'super_admin'); assert.equal(me.company, null);
  expect(await call('GET', '/v1/employees', l.token), 403, 'FORBIDDEN');
  ok('staff: password sign-in, no company, no employee data');
  await staffRoutes(l.token, me.id);
}

const COMPANY_KEYS = ['created_at', 'custom_domain', 'custom_domain_checked_at', 'custom_domain_status', 'expired_blocking_grace_days', 'id', 'key_last4',
  'mrr_estimate', 'name', 'plan', 'screenshot_tier', 'seat_limit', 'seats_used', 'slug', 'status', 'suspended_reason', 'trial_ends_at'];

// Staff API (admin round 4). STAFF_TARGET_SLUG names a throwaway company: its key is reissued and it becomes Enterprise.
async function staffRoutes(t: string, myId: string, adminToken?: string) {
  const list = expect(await call('GET', '/v1/staff/companies', t), 200);
  assert.ok(list.items.length && list.totals.companies === list.items.length);
  assert.deepEqual(Object.keys(list.items[0]).sort(), COMPANY_KEYS, 'company row carries only the specified fields');
  expect(await call('GET', '/v1/staff/companies?status=bogus', t), 422);
  expect(await call('GET', `/v1/staff/companies/${randomUUID()}`, t), 404, 'NOT_FOUND');
  expect(await call('GET', '/v1/staff/companies/not-a-uuid', t), 404, 'NOT_FOUND');
  if (adminToken) expect(await call('GET', '/v1/staff/companies', adminToken), 403, 'FORBIDDEN');
  ok('staff companies: list, totals, fields, 404, 403');

  // WorkBeat private sites (admin round 9): staff keep them; companies see them and cannot touch them.
  const host = `wb-${randomUUID().slice(0, 8)}.example`;
  const site = expect(await call('POST', '/v1/staff/sensitive-domains', t, { pattern: host }), 201);
  expect(await call('POST', '/v1/staff/sensitive-domains', t, { pattern: host }), 409);
  expect(await call('POST', '/v1/staff/sensitive-domains', t, { pattern: '*.bank' }), 422);
  assert.ok(expect(await call('GET', '/v1/staff/sensitive-domains', t), 200).some((x: any) => x.id === site.id));
  if (adminToken) {
    expect(await call('GET', '/v1/staff/sensitive-domains', adminToken), 403, 'FORBIDDEN');
    const mine = expect(await call('GET', '/v1/sensitive-domains', adminToken), 200).find((x: any) => x.id === site.id);
    assert.equal(mine?.source, 'workbeat');
    expect(await call('POST', '/v1/sensitive-domains', adminToken, { pattern: host }), 409);
    expect(await call('DELETE', `/v1/sensitive-domains/${site.id}`, adminToken), 404);
  }
  expect(await call('DELETE', `/v1/staff/sensitive-domains/${site.id}`, t), 204);
  ok('WorkBeat private sites: add, 409, 422, company sees read-only, remove');

  const slug = process.env.STAFF_TARGET_SLUG;
  if (slug) {
    const co = expect(await call('GET', `/v1/staff/companies?q=${slug}`, t), 200).items.find((x: any) => x.slug === slug);
    assert.ok(co, 'target company found by q');
    assert.equal(expect(await call('POST', `/v1/staff/companies/${co.id}/suspend`, t), 200).suspended_reason, 'staff');
    assert.notEqual(expect(await call('POST', `/v1/staff/companies/${co.id}/restore`, t), 200).status, 'suspended');
    assert.equal(expect(await call('PATCH', `/v1/staff/companies/${co.id}`, t, { expired_blocking_grace_days: 14 }), 200).expired_blocking_grace_days, 14);
    expect(await call('PATCH', `/v1/staff/companies/${co.id}`, t, { expired_blocking_grace_days: 366 }), 422);
    const named = expect(await call('PATCH', `/v1/staff/companies/${co.id}`, t, { name: co.name, data_retention_days: 60 }), 200);
    assert.equal(named.data_retention_days, 60); assert.equal(named.expired_blocking_grace_days, 14, 'grace kept');
    expect(await call('PATCH', `/v1/staff/companies/${co.id}`, t, { data_retention_days: 45 }), 422);
    expect(await call('PATCH', `/v1/staff/companies/${co.id}`, t, { data_retention_days: 90 }), 200);
    // B30: plan, seats, screenshot tier and status are all staff-set.
    const before = expect(await call('GET', `/v1/staff/companies/${co.id}`, t), 200);
    expect(await call('PATCH', `/v1/staff/companies/${co.id}/license`, t, { plan: 'growth', seat_limit: null }), 422, 'VALIDATION_FAILED');
    expect(await call('PATCH', `/v1/staff/companies/${co.id}/license`, t, {}), 422);
    if (before.seats_used > 1) expect(await call('PATCH', `/v1/staff/companies/${co.id}/license`, t, { seat_limit: 1 }), 409, 'CONFLICT');
    const grown = expect(await call('PATCH', `/v1/staff/companies/${co.id}/license`, t, { plan: 'growth', seat_limit: before.seats_used + 5, screenshot_tier: 'light' }), 200);
    assert.equal(grown.plan, 'growth'); assert.equal(grown.screenshot_tier, 'light');
    const ent = expect(await call('PATCH', `/v1/staff/companies/${co.id}/license`, t, { plan: 'enterprise', seat_limit: null }), 200);
    assert.equal(ent.plan, 'enterprise'); assert.equal(ent.seat_limit, null); assert.equal(ent.screenshot_tier, 'light', 'tier kept');
    expect(await call('PATCH', `/v1/staff/companies/${co.id}/license`, t, { screenshot_tier: before.screenshot_tier }), 200);
    const exp = expect(await call('PATCH', `/v1/staff/companies/${co.id}`, t, { status: 'expired' }), 200);
    assert.equal(exp.status, 'expired');
    expect(await call('PATCH', `/v1/staff/companies/${co.id}`, t, { status: 'trial' }), before.trial_ends_at && Date.parse(before.trial_ends_at) > Date.now() ? 200 : 422);
    assert.equal(expect(await call('PATCH', `/v1/staff/companies/${co.id}`, t, { status: 'trial', trial_days: 14 }), 200).status, 'trial');
    const sus = expect(await call('PATCH', `/v1/staff/companies/${co.id}`, t, { status: 'suspended' }), 200);
    assert.equal(sus.suspended_reason, 'staff');
    const act = expect(await call('PATCH', `/v1/staff/companies/${co.id}`, t, { status: 'active' }), 200);
    assert.equal(act.status, 'active'); assert.equal(act.suspended_reason, null);
    assert.ok(Date.parse(act.trial_ends_at) <= Date.now(), 'active ends the trial');
    expect(await call('POST', `/v1/staff/companies/${co.id}/suspend`, t), 200);
    assert.equal(expect(await call('POST', `/v1/staff/companies/${co.id}/restore`, t), 200).status, 'active', 'an ended trial is not restored');
    const re = await call('POST', `/v1/staff/companies/${co.id}/license/reissue`, t);
    assert.match(expect(re, 200).key, /^WB-[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
    assert.equal(re.headers.get('cache-control'), 'no-store');
    expect(await call('POST', '/v1/license/validate', undefined, {}, { 'x-license-key': re.json.data.key }), 200);
    ok('staff company actions: suspend, restore, grace, name and retention, plan, seats, tier, status, reissue');
  }

  const rel = { product: 'downloader', platform: 'windows', arch: 'x64', version: `0.0.${Date.now() % 100000}` };
  expect(await call('POST', '/v1/staff/agent-releases/upload-url', t, { ...rel, arch: 'universal' }), 422);
  const up = expect(await call('POST', '/v1/staff/agent-releases/upload-url', t, rel), 200);
  const bytes = Buffer.from('smoke package ' + run);
  assert.equal((await fetch(up.upload_url, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes })).status, 200);
  const sha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  const body = { ...rel, min_supported: '0.0.0', storage_path: up.storage_path, sha256: sha, size_bytes: bytes.length };
  expect(await call('POST', '/v1/staff/agent-releases', t, { ...body, size_bytes: bytes.length + 1 }), 422);
  expect(await call('POST', '/v1/staff/agent-releases', t, { ...body, signature: '' }), 422);
  const r = expect(await call('POST', '/v1/staff/agent-releases', t, body), 201);
  assert.equal(r.signature, null);
  expect(await call('POST', '/v1/staff/agent-releases', t, body), 409, 'CONFLICT');
  assert.ok(expect(await call('GET', '/v1/staff/agent-releases', t), 200).some((x: any) => x.id === r.id));
  const w = expect(await call('POST', `/v1/staff/agent-releases/${r.id}/withdraw`, t), 200);
  assert.ok(w.withdrawn_at);
  assert.equal(expect(await call('POST', `/v1/staff/agent-releases/${r.id}/withdraw`, t), 200).withdrawn_at, w.withdrawn_at);
  ok('agent releases: upload URL, unsigned Windows, size check, 409, withdraw twice');

  const email = `staff-${run}@example.test`;
  const inv = expect(await call('POST', '/v1/staff/invitations', t, { email }), 201);
  assert.equal(inv.role, 'super_admin');
  expect(await call('POST', '/v1/staff/invitations', t, { email }), 409, 'CONFLICT');
  expect(await call('POST', `/v1/staff/invitations/${inv.id}/resend`, t), 200);
  const team = expect(await call('GET', '/v1/staff/team', t), 200);
  assert.ok(team.invitations.some((x: any) => x.id === inv.id) && team.users.every((x: any) => !('mfa_enabled' in x)));
  const tok = decodeURIComponent(inviteToken(email));
  assert.equal(expect(await call('POST', '/v1/invitations/lookup', undefined, { token: tok }), 200).company_name, null);
  const acc = expect(await call('POST', '/v1/invitations/accept', undefined, { token: tok, name: 'Smoke Staff', password: 'correct horse battery' }), 201);
  assert.equal(acc.token, undefined, 'staff accept issues no session');
  expect(await call('POST', '/v1/auth/login', undefined, { email, password: 'correct horse battery' }), 200);
  expect(await call('DELETE', `/v1/staff/users/${myId}`, t), 409, 'CONFLICT');
  expect(await call('DELETE', `/v1/staff/users/${acc.user.id}`, t), 204);
  expect(await call('DELETE', `/v1/staff/users/${acc.user.id}`, t), 404, 'NOT_FOUND');
  const inv2 = expect(await call('POST', '/v1/staff/invitations', t, { email: `staff2-${run}@example.test` }), 201);
  expect(await call('DELETE', `/v1/staff/invitations/${inv2.id}`, t), 204);
  ok('staff team: invite, resend, accept without session, remove, cancel');

  await staffRound5(t);
}

// Admin round 5: staff create a company; a Company Admin's temporary password.
async function staffRound5(t: string) {
  const slug = `r5-${run}`, adminEmail = `r5-admin-${run}@example.test`;
  const body = { name: `R5 ${run}`, slug, plan: 'starter', seat_limit: 3, screenshot_tier: 'off', status: 'trial', trial_days: 14, timezone: 'Asia/Dhaka', admin_email: adminEmail };
  assert.deepEqual((await call('POST', '/v1/staff/companies', t, { ...body, seat_limit: null })).json.fields, ['seat_limit']);
  assert.deepEqual((await call('POST', '/v1/staff/companies', t, { ...body, timezone: 'Mars/Base' })).json.fields, ['timezone']);
  assert.deepEqual((await call('POST', '/v1/staff/companies', t, { ...body, trial_days: undefined })).json.fields, ['trial_days']);
  const made = expect(await call('POST', '/v1/staff/companies', t, body), 201);
  assert.equal(made.company.slug, slug); assert.equal(made.company.status, 'trial'); assert.ok(made.company.trial_ends_at);
  assert.equal(made.invitation.email, adminEmail); assert.equal(JSON.stringify(made).includes('WB-'), false, 'no key in the body');
  assert.deepEqual((await call('POST', '/v1/staff/companies', t, { ...body, admin_email: `other-${run}@example.test` })).json.fields, ['slug']);
  assert.deepEqual((await call('POST', '/v1/staff/companies', t, { ...body, slug: `${slug}-b` })).json.fields, ['admin_email']);
  await new Promise((r) => setTimeout(r, 300)); // email sent after the answer
  const tok = decodeURIComponent(inviteToken(adminEmail));
  const acc = expect(await call('POST', '/v1/invitations/accept', undefined, { token: tok, name: 'R5 Admin', password: 'correct horse battery' }), 201);
  assert.equal(acc.user.company.slug, slug);
  ok('staff create company: validation, 409 fields, invitation email, admin joins');

  const admins = expect(await call('GET', `/v1/staff/company-admins?q=${slug}`, t), 200);
  assert.equal(admins.length, 1); assert.equal(admins[0].email, adminEmail); assert.equal(admins[0].must_change_password, false);
  expect(await call('POST', `/v1/staff/users/${randomUUID()}/temporary-password`, t), 404, 'NOT_FOUND');
  const tp = await call('POST', `/v1/staff/users/${acc.user.id}/temporary-password`, t);
  const temp = expect(tp, 200).temporary_password as string;
  assert.equal(tp.headers.get('cache-control'), 'no-store'); assert.ok(temp.length >= 12 && !/[0O1lIi]/.test(temp));
  expect(await call('GET', '/v1/me', acc.token), 401); // sessions ended
  const l = expect(await call('POST', '/v1/auth/login', undefined, { email: adminEmail, password: temp }), 200);
  assert.equal(l.user.must_change_password, true);
  assert.equal(expect(await call('GET', '/v1/me', l.token), 200).must_change_password, true);
  expect(await call('GET', '/v1/employees', l.token), 403, 'PASSWORD_CHANGE_REQUIRED');
  assert.deepEqual((await call('POST', '/v1/auth/password', l.token, { current_password: temp, new_password: temp })).json.fields, ['new_password']);
  expect(await call('POST', '/v1/auth/password', l.token, { current_password: temp, new_password: 'my own long password' }), 200);
  assert.equal(expect(await call('GET', '/v1/me', l.token), 200).must_change_password, false);
  expect(await call('GET', '/v1/employees', l.token), 200);
  ok('temporary password: once, no-store, forced change, then normal access');
}

// Company routes and gaps of admin round 4.
async function round4(admin: string, companyId: string) {
  const host = `smoke-${run}.example.com`;
  // B33: the company admin sets the domain; it resolves only after staff approve it.
  const set = expect(await call('PUT', '/v1/company/custom-domain', admin, { domain: `${host.toUpperCase()}.` }), 200);
  assert.equal(set.domain, host); assert.equal(set.status, 'pending'); assert.equal(set.txt_name, `_workbeat.${host}`);
  assert.equal(expect(await call('PUT', '/v1/company/custom-domain', admin, { domain: host }), 200).txt_value, set.txt_value, 'same domain keeps its token');
  expect(await call('PUT', '/v1/company/custom-domain', admin, { domain: 'WORKBEAT.IO' }), 422, 'VALIDATION_FAILED');
  expect(await call('GET', `/v1/hosts/resolve?host=${host}`), 404, 'NOT_FOUND');
  if (process.env.STAFF1_EMAIL) {
    const t = expect(await call('POST', '/v1/auth/login', undefined, { email: process.env.STAFF1_EMAIL, password: process.env.STAFF1_PASSWORD }), 200).token;
    const path = `/v1/staff/companies/${companyId}/custom-domain`;
    assert.equal(expect(await call('GET', path, t), 200).txt_value, set.txt_value);
    expect(await call('PATCH', path, admin, { domain: host, status: 'active' }), 403, 'FORBIDDEN');
    expect(await call('PATCH', path, t, { domain: `old-${host}`, status: 'active' }), 409, 'CONFLICT');
    assert.ok(expect(await call('PATCH', path, t, { domain: host, status: 'active' }), 200).verified_at);
    expect(await call('GET', `/v1/hosts/resolve?host=${host.toUpperCase()}`), 200);
    expect(await call('PATCH', path, t, { domain: host, status: 'failed' }), 200);
    expect(await call('GET', `/v1/hosts/resolve?host=${host}`), 404, 'NOT_FOUND');
  }
  expect(await call('DELETE', '/v1/company/custom-domain', admin), 204);
  assert.equal((await call('GET', '/v1/company/custom-domain', admin)).json.data, null);
  const slug = expect(await call('GET', '/v1/company/settings', admin), 200).slug;
  assert.equal(expect(await call('GET', `/v1/hosts/resolve?host=${slug.toUpperCase()}.workbeat.io`), 200).slug, slug);
  expect(await call('GET', `/v1/hosts/resolve?host=x.${slug}.workbeat.io`), 404, 'NOT_FOUND');
  ok('custom domain: admin sets, staff approve, only active resolves');

  assert.deepEqual((await call('PATCH', '/v1/company/settings', admin, { alert_email: { roles: [], types: [], delivery: 'instant' } })).json.fields, ['alert_email.roles']);
  const hook = 'https://hooks.slack.com/services/T0/B0/smoke';
  const withHook = await call('PATCH', '/v1/company/settings', admin, { slack_webhook_url: hook });
  assert.equal(expect(withHook, 200).slack_webhook_set, true); assert.ok(!JSON.stringify(withHook.json).includes('hooks.slack'), 'webhook never returned');
  assert.deepEqual((await call('PATCH', '/v1/company/settings', admin, { slack_webhook_url: 'https://example.com/hook' })).json.fields, ['slack_webhook_url']);
  assert.equal(expect(await call('PATCH', '/v1/company/settings', admin, { slack_webhook_url: null }), 200).slack_webhook_set, false);
  ok('slack webhook: set, refused off Slack, removed');
  assert.ok('min_agent_version' in expect(await call('GET', '/v1/license', admin), 200));
  const emps = expect(await call('GET', '/v1/employees', admin), 200);
  const e = (emps.items ?? emps)[0];
  if (e) {
    const monday = new Date(); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const r = await fetch(`${BASE}/v1/employees/${e.id}/timesheet.pdf?week=${monday.toISOString().slice(0, 10)}`, { headers: { authorization: `Bearer ${admin}` } });
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.ok(Buffer.from(await r.arrayBuffer()).subarray(0, 5).toString() === '%PDF-');
  }
  ok('gaps: alert roles [] refused, min_agent_version on licence, timesheet.pdf');
}

async function main() {
  expect(await call('POST', '/v1/auth/login', undefined, { email: process.env.ADMIN_EMAIL, password: 'wrong-password' }), 401, 'UNAUTHENTICATED');
  const login = expect(await call('POST', '/v1/auth/login', undefined, { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }), 200);
  const admin: string = login.token;
  assert.ok(login.user.company?.id, 'login response carries the company');
  const me = expect(await call('GET', '/v1/me', admin), 200);
  assert.equal(me.role, 'company_admin'); assert.ok(me.company.timezone);
  expect(await call('GET', '/v1/me'), 401, 'UNAUTHENTICATED');
  ok(`login as ${me.email} (${me.company.name})`);

  // Custom roles: the old Manager and IT Admin, made by the Company Admin (0013).
  const mgrRole = expect(await call('POST', '/v1/roles', admin, { name: `Manager ${run}`, permissions: ['reports', 'employees.view', 'alerts.view', 'policy.view'], team_only: true }), 201);
  const itRole = expect(await call('POST', '/v1/roles', admin, { name: `IT Admin ${run}`,
    permissions: ['employees.edit', 'devices.edit', 'alerts.edit', 'policy.edit', 'deployment'] }), 201);
  assert.ok(itRole.permissions.includes('devices.view'), 'an edit right brings its view right');
  expect(await call('POST', '/v1/roles', admin, { name: `manager ${run}`, permissions: [] }), 409, 'CONFLICT');
  expect(await call('POST', '/v1/roles', admin, { name: 'Bad', permissions: ['billing'] }), 422);
  const mgr = await join_(admin, mgrRole.id, 'manager');
  const it = await join_(admin, itRole.id, 'it_admin');
  expect(await call('GET', '/v1/roles', mgr.token), 403, 'FORBIDDEN');
  const meIt = expect(await call('GET', '/v1/me', it.token), 200);
  assert.equal(meIt.role, 'member'); assert.equal(meIt.role_name, `IT Admin ${run}`); assert.equal(meIt.team_only, false);
  expect(await call('DELETE', `/v1/roles/${itRole.id}`, admin), 409, 'CONFLICT');
  expect(await call('POST', '/v1/team/invitations', admin, { email: mgr.email, role: 'member', role_id: mgrRole.id }), 409, 'CONFLICT');
  expect(await call('POST', '/v1/team/invitations', admin, { email: `x-${run}@example.test`, role: 'super_admin' }), 422);
  expect(await call('GET', '/v1/team', mgr.token), 403, 'FORBIDDEN');
  const team = expect(await call('GET', '/v1/team', admin), 200);
  assert.ok(team.users.some((u: any) => u.id === mgr.id));
  assert.equal(team.users.filter((u: any) => u.role === 'company_admin').length, 1, 'the smoke company has one Company Admin');
  expect(await call('PATCH', `/v1/team/users/${me.id}`, admin, { role: 'member', role_id: mgrRole.id }), 409);
  ok('custom roles; invitations → manager and it_admin accounts; last-admin guard');

  // employees
  const ada = expect(await call('POST', '/v1/employees', admin, { name: `Ada ${run}`, email: `ada-${run}@example.test`, manager_user_id: mgr.id }), 201);
  const bob = expect(await call('POST', '/v1/employees', admin, { name: `Bob ${run}`, email: `bob-${run}@example.test` }), 201);
  expect(await call('POST', '/v1/employees', admin, { name: 'Dup', email: `ada-${run}@example.test` }), 409, 'CONFLICT');
  expect(await call('POST', '/v1/employees', admin, { name: 'X', email: `x-${run}@example.test`, manager_user_id: it.id }), 422);
  expect(await call('POST', '/v1/employees', mgr.token, { name: 'X', email: `x-${run}@example.test` }), 403);
  const mine = expect(await call('GET', '/v1/employees', mgr.token), 200);
  assert.ok(mine.some((e: any) => e.id === ada.id) && !mine.some((e: any) => e.id === bob.id));
  expect(await call('GET', `/v1/employees/${bob.id}`, mgr.token), 404, 'NOT_FOUND');
  const itList = expect(await call('GET', '/v1/employees', it.token), 200);
  assert.ok('presence' in itList[0] && 'manager_user_id' in itList[0], 'it_admin sees the admin fields (round 6)');
  expect(await call('PATCH', `/v1/employees/${bob.id}`, admin, { department: 'Ops' }), 200);
  const csv = `\uFEFFname,email,department,manager email\r\nCara ${run},cara-${run}@example.test,Sales,${mgr.email}\r\nAda again,ada-${run}@example.test,,\r\n`;
  const chk = expect(await call('POST', '/v1/employees/import/check', it.token, csv, { 'content-type': 'text/csv' }), 200); // read-only: no approval
  assert.deepEqual([chk.rows, chk.invalid], [2, [{ line: 2, reasons: ['email_exists'] }]]);
  const dupImp = await call('POST', '/v1/employees/import', admin, csv, { 'content-type': 'text/csv' });
  expect(dupImp, 422); assert.deepEqual(dupImp.json.lines, [2]);
  const imp = expect(await call('POST', '/v1/employees/import', admin, csv.replace(/Ada again.*\r\n/, ''), { 'content-type': 'text/csv' }), 201);
  assert.equal(imp.created, 1);
  const badImp = await call('POST', '/v1/employees/import', admin, `Dee,not-an-email,,\n,x@y.test,,\nEve,x@y.test,,nobody@example.test\n`, { 'content-type': 'text/csv' });
  expect(badImp, 422); assert.deepEqual(badImp.json.lines, [1, 2, 3]);
  assert.deepEqual(badImp.json.invalid[2].reasons, ['email_repeated', 'manager_unknown']);
  const big = Array.from({ length: 501 }, (_, i) => `P${i},p${i}-${run}@example.test,,`).join('\n');
  expect(await call('POST', '/v1/employees/import/check', admin, big, { 'content-type': 'text/csv' }), 413, 'PAYLOAD_TOO_LARGE');
  expect(await call('POST', '/v1/employees/import/check', admin, 'name,email\n', { 'content-type': 'text/csv' }), 422);
  expect(await call('POST', '/v1/employees/import/check', mgr.token, csv, { 'content-type': 'text/csv' }), 403);
  ok('employees: create, team scoping, it_admin fields, CSV import');

  // monitoring settings + pauses
  const all = { activity: true, app_usage: true, window_titles: false, website_visits: true };
  expect(await call('PUT', `/v1/employees/${ada.id}/monitoring-settings`, admin, { ...all, screenshot_interval_seconds: 600 }), 422);
  expect(await call('PUT', `/v1/employees/${ada.id}/monitoring-settings`, admin, { ...all, screenshot_interval_seconds: 1800 }), 200);
  expect(await call('PUT', `/v1/employees/${ada.id}/monitoring-settings`, mgr.token, { ...all, screenshot_interval_seconds: 0 }), 403);
  expect(await call('GET', `/v1/employees/${ada.id}/monitoring-settings`, it.token), 200); // round 6: it_admin reads settings
  assert.ok(['off', 'light', 'standard', 'intensive'].includes(expect(await call('GET', `/v1/employees/${ada.id}/monitoring-settings`, admin), 200).screenshot_tier));
  const start = new Date(Date.now() + 86400_000), end = new Date(Date.now() + 2 * 86400_000);
  const pause = expect(await call('POST', `/v1/employees/${ada.id}/pauses`, admin, { starts_at: start.toISOString(), ends_at: end.toISOString(), reason: 'annual_leave' }), 201);
  assert.equal(pause.status, 'scheduled'); assert.equal(pause.created_by_name, me.name);
  expect(await call('POST', `/v1/employees/${ada.id}/pauses`, admin, { starts_at: start.toISOString(), ends_at: end.toISOString(), reason: 'personal' }), 409);
  expect(await call('PATCH', `/v1/employees/${ada.id}/pauses/${pause.id}`, admin, { ends_at: new Date(end.getTime() + 3600_000).toISOString() }), 200);
  expect(await call('POST', `/v1/employees/${ada.id}/pauses/${pause.id}/cancel`, admin), 200);
  expect(await call('POST', `/v1/employees/${ada.id}/pauses/${pause.id}/cancel`, admin), 409);
  ok('monitoring settings (tier rule) and pauses (overlap, extend, cancel)');

  // policy
  const dom = `blocked-${run}.example`;
  const pendingRule = expect(await call('POST', '/v1/block-rules', it.token, { type: 'domain', pattern: dom.toUpperCase() }), 202).change;
  assert.equal(pendingRule.status, 'pending'); assert.equal(pendingRule.summary, `Block website ${dom.toUpperCase()}`);
  expect(await call('POST', '/v1/block-rules', it.token, { type: 'domain', pattern: 'https://x.com/a' }), 422); // validated at once
  assert.ok(!expect(await call('GET', '/v1/block-rules', admin), 200).some((r: any) => r.pattern === dom), 'nothing applied before approval');
  const appliedRule = expect(await call('POST', `/v1/changes/${pendingRule.id}/approve`, admin), 200).change;
  assert.equal(appliedRule.status, 'approved'); assert.equal(appliedRule.decided_by.name, me.name);
  assert.ok(expect(await call('GET', '/v1/block-rules', admin), 200).some((r: any) => r.pattern === dom), 'applied on approval');
  expect(await call('POST', `/v1/changes/${pendingRule.id}/approve`, admin), 409, 'CONFLICT');
  expect(await call('POST', '/v1/block-rules', it.token, { type: 'domain', pattern: dom }), 409); // conflicts show at once
  const again = expect(await call('POST', '/v1/block-rules', it.token, { type: 'domain', pattern: `x-${dom}` }), 202).change;
  const rej = expect(await call('POST', `/v1/changes/${again.id}/reject`, admin, { reason: 'Not now' }), 200).change;
  assert.equal(rej.status, 'rejected'); assert.equal(rej.reason, 'Not now');
  const mine2 = expect(await call('POST', '/v1/block-rules', it.token, { type: 'domain', pattern: `y-${dom}` }), 202).change;
  expect(await call('DELETE', `/v1/changes/${mine2.id}`, admin), 404); // only the one who asked cancels
  expect(await call('DELETE', `/v1/changes/${mine2.id}`, it.token), 204);
  expect(await call('DELETE', `/v1/changes/${mine2.id}`, it.token), 409, 'CONFLICT');
  assert.deepEqual(expect(await call('GET', '/v1/changes', mgr.token), 200), []); // everyone sees their own
  const itChanges = expect(await call('GET', '/v1/changes', it.token), 200);
  assert.deepEqual(itChanges.slice(0, 3).map((x: any) => x.status), ['cancelled', 'rejected', 'approved']);
  assert.ok(expect(await call('GET', '/v1/changes?status=pending', admin), 200).every((x: any) => x.status === 'pending'));
  const delay = expect(await call('POST', '/v1/employees', it.token, { name: `Late ${run}`, email: `late-${run}@example.test` }), 202).change;
  expect(await call('POST', '/v1/employees', admin, { name: `Late ${run}`, email: `late-${run}@example.test` }), 201);
  const failed = expect(await call('POST', `/v1/changes/${delay.id}/approve`, admin), 200).change;
  assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'CONFLICT');
  ok('change approvals: 202 pending, validated at once, approve applies, reject, cancel, failed replay');

  // Maker-checker between Company Admins: with a second one, an admin's write waits for the other.
  const admin2 = await join_(admin, null, 'admin2');
  const own = expect(await call('POST', '/v1/block-rules', admin, { type: 'domain', pattern: `z-${dom}` }), 202).change;
  expect(await call('POST', `/v1/changes/${own.id}/approve`, admin), 403, 'FORBIDDEN');
  expect(await call('POST', `/v1/changes/${own.id}/reject`, admin), 403, 'FORBIDDEN');
  assert.equal(expect(await call('POST', `/v1/changes/${own.id}/approve`, admin2.token), 200).change.status, 'approved');
  const itAsk = expect(await call('POST', '/v1/block-rules', it.token, { type: 'domain', pattern: `w-${dom}` }), 202).change;
  assert.equal(expect(await call('POST', `/v1/changes/${itAsk.id}/approve`, admin2.token), 200).change.status, 'approved', 'any admin approves a member alone');
  // A deferred invitation is a trial run: no email until approved, then one email whose link works; approved once only.
  const lateEmail = `deferred-${run}@example.test`;
  const deferredInv = expect(await call('POST', '/v1/team/invitations', admin, { email: lateEmail, role: 'company_admin' }), 202).change;
  assert.ok(!readdirSync(OUTBOX).some((n) => n.includes(lateEmail)), 'a deferred invitation sends no email');
  assert.equal(expect(await call('POST', `/v1/changes/${deferredInv.id}/approve`, admin2.token), 200).change.status, 'approved');
  expect(await call('POST', '/v1/invitations/lookup', undefined, { token: decodeURIComponent(inviteToken(lateEmail)) }), 200);
  expect(await call('POST', `/v1/changes/${deferredInv.id}/approve`, admin2.token), 409, 'CONFLICT');
  const drop = expect(await call('DELETE', `/v1/team/users/${admin2.id}`, admin), 202).change;
  expect(await call('POST', `/v1/changes/${drop.id}/approve`, admin2.token), 200);
  expect(await call('POST', '/v1/block-rules', admin, { type: 'domain', pattern: `v-${dom}` }), 201); // alone again: no wait
  ok('maker-checker: a second Company Admin approves, never the maker; a lone admin acts at once; invite mailed only once approved');
  const fromRegex = expect(await call('POST', '/v1/block-rules', admin, { type: 'regex', pattern: `^(www\\.)?(a-${run}\\.com|b-${run}\\.com)/games.*$` }), 201);
  assert.deepEqual(fromRegex.map((r: any) => r.pattern), [`a-${run}.com/games`, `b-${run}.com/games`]);
  expect(await call('POST', '/v1/block-rules', admin, { type: 'regex', pattern: '.*evil.*' }), 422);
  expect(await call('POST', '/v1/block-rules', mgr.token, { type: 'domain', pattern: 'x.com' }), 403);
  expect(await call('GET', '/v1/block-rules', mgr.token), 200);
  const sd = expect(await call('POST', '/v1/sensitive-domains', admin, { pattern: `bank-${run}.example` }), 201);
  expect(await call('POST', '/v1/sensitive-domains', admin, { pattern: '*.bank' }), 422);
  expect(await call('GET', '/v1/sensitive-domains', it.token), 200);
  expect(await call('DELETE', `/v1/sensitive-domains/${sd.id}`, admin), 204);
  expect(await call('POST', '/v1/productivity-rules', admin, { match_type: 'app', pattern: `Code${run}`, category: 'productive' }), 201);
  expect(await call('POST', '/v1/productivity-rules', admin, { match_type: 'domain', pattern: `fun-${run}.example`, category: 'unproductive' }), 201);
  const n0 = expect(await call('GET', '/v1/settings/notice', admin), 200);
  expect(await call('PUT', '/v1/settings/notice', admin, { notice_text: n0.notice_text + ` (${run})` }), 403, 'FORBIDDEN');
  assert.equal(expect(await call('GET', '/v1/settings/notice', admin), 200).notice_version, n0.notice_version);
  ok('block rules (domain, regex → url), sensitive domains, productivity rules, notice read only');

  // licence, settings, setup
  expect(await call('GET', '/v1/license', it.token), 403); // round 6: no Deployment area for it_admin
  expect(await call('POST', '/v1/license/reveal', it.token), 403);
  const lic = expect(await call('GET', '/v1/license', admin), 200);
  const key = expect(await call('POST', '/v1/license/reveal', admin), 200).key;
  assert.ok(key.endsWith(lic.key_masked.slice(-4)));
  expect(await call('POST', '/v1/license/reveal', mgr.token), 403);
  expect(await call('POST', '/v1/license/uninstall-token/reveal', admin), 200);
  expect(await call('PATCH', '/v1/company/settings', admin, { timezone: 'Not/AZone' }), 422);
  expect(await call('PATCH', '/v1/company/settings', admin, { timezone: 'Asia/Dhaka', idle_threshold_seconds: 300 }), 200);
  expect(await call('PATCH', '/v1/company/settings', it.token, { name: 'x' }), 403);
  const staffOnly = await call('PATCH', '/v1/company/settings', admin, { name: 'x', data_retention_days: 30, timezone: 'UTC' });
  assert.equal(staffOnly.status, 403); assert.deepEqual(staffOnly.json.fields, ['name', 'data_retention_days']);
  assert.equal(expect(await call('GET', '/v1/company/settings', admin), 200).timezone, 'Asia/Dhaka', 'refused patch changes nothing');
  expect(await call('POST', '/v1/company/setup/steps', admin, { step: 'copy_license_key' }), 204);
  assert.ok(expect(await call('GET', '/v1/company/setup', admin), 200).find((s: any) => s.step === 'copy_license_key').done);
  expect(await call('GET', '/v1/company/setup', it.token), 403);
  expect(await call('GET', '/v1/company/status', mgr.token), 200);
  expect(await call('GET', '/v1/billing', admin), 403, 'FORBIDDEN');
  ok('licence reveal, settings (timezone check, staff-only fields), setup, status, billing refused');

  // an agent for Ada produces data
  const tok = expect(await call('POST', '/v1/license/validate', undefined, { employee_id: ada.id }, { 'x-license-key': key }), 200).enrollment_token;
  const dev = expect(await call('POST', '/v1/devices/enroll', tok, { hostname: `mac-${run}`, os: 'macos', os_version: '15.1', arch: 'arm64', hardware_id: `hw-${run}`, agent_version: '1.0.0' }), 201);
  const dk = { 'x-device-key': dev.device_key };
  expect(await call('POST', '/v1/agents/heartbeat', undefined, { agent_version: '1.0.0', permissions: { accessibility: 'granted', screen_recording: 'pending' } }, dk), 200);
  const now = Date.now(), batch = randomUUID();
  expect(await call('POST', '/v1/agents/activity', undefined, {
    batch_id: batch,
    app_sessions: [
      { session_user: 'ada', bundle_id: 'x', app_name: `Code${run}`, process_name: 'code', started_at: now - 3600_000, ended_at: now - 1800_000, duration_seconds: 1800 },
      { session_user: 'ada', bundle_id: 'com.apple.Safari', app_name: 'Safari', process_name: 'Safari', started_at: now - 1800_000, ended_at: now - 600_000, duration_seconds: 1200 },
    ],
    url_visits: [{ session_user: 'ada', browser: 'safari', url: `https://www.fun-${run}.example/`, domain: `www.fun-${run}.example`, visited_at: now - 1800_000, duration_seconds: 1200 }],
    activity_buckets: [{ bucket_start: now - 1800_000, active_samples: 3, total_samples: 4 }],
    idle_intervals: [{ session_user: 'ada', started_at: now - 600_000, ended_at: now - 300_000 }],
  }, { ...dk, 'idempotency-key': batch }), 200);
  expect(await call('POST', '/v1/agents/tamper', undefined, { id: randomUUID(), event_type: 'hosts_modified', detail: {}, occurred_at: now }, dk), 201);
  const alertMail = () => readdirSync(OUTBOX).filter((n) => n.includes(process.env.ADMIN_EMAIL!)).map((n) => JSON.parse(readFileSync(join(OUTBOX, n), 'utf8')))
    .find((m) => m.subject === 'WorkBeat alert: Tamper detected' && m.text.includes('Event: Website blocking changed') && m.text.includes('Employee: '));
  for (let i = 0; i < 20 && !alertMail(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(alertMail(), 'tamper alert emailed to the company admin');

  const devices = expect(await call('GET', '/v1/devices', it.token), 200);
  const d = devices.find((x: any) => x.id === dev.device_id);
  assert.equal(d.status, 'online', 'an open alert is not a status (B31)'); assert.ok(d.badges.includes('permission_pending') && d.badges.includes('open_alert'));
  assert.ok('released_at' in d && 'uninstalled_at' in d && !('deactivated_at' in d)); // B35, B36
  const adaNow = expect(await call('GET', `/v1/employees/${ada.id}`, mgr.token), 200);
  assert.ok(['active', 'idle'].includes(adaNow.presence), 'an open alert leaves presence to the devices'); assert.equal(adaNow.devices[0].id, dev.device_id);
  assert.equal(expect(await call('GET', '/v1/employees', admin), 200).find((e: any) => e.id === bob.id).presence, 'no_device');
  const team2 = expect(await call('GET', `/v1/employees?manager_user_id=${mgr.id}`, admin), 200);
  assert.ok(team2.every((e: any) => e.manager_user_id === mgr.id) && team2.some((e: any) => e.id === ada.id));
  const detail = expect(await call('GET', `/v1/devices/${dev.device_id}`, it.token), 200);
  for (const k of ['store_bytes', 'dropped_records', 'screenshot_skips', 'outdated', 'notice_ack_version']) assert.ok(k in detail.health, k);
  const fa = expect(await call('GET', `/v1/alerts?employee_id=${ada.id}`, admin), 200);
  assert.ok(fa.items.length >= 1 && fa.items.every((a: any) => a.employee.id === ada.id)); assert.ok(fa.counts.hosts_modified >= 1);
  assert.ok(expect(await call('GET', '/v1/block-rules', mgr.token), 200).find((r: any) => r.pattern === dom).created_by_name);
  expect(await call('GET', '/v1/agent-versions', it.token), 200);
  expect(await call('GET', '/v1/agent-versions', mgr.token), 403);
  ok('admin asks: timezone, presence, devices, manager filter, health, alert counts, creator name, agent versions');
  expect(await call('GET', '/v1/devices', mgr.token), 403);
  expect(await call('GET', '/v1/rollout', admin), 200);
  const feed = expect(await call('GET', '/v1/alerts?state=open', mgr.token), 200);
  const alert = feed.items.find((a: any) => a.device_id === dev.device_id);
  assert.ok(alert);
  expect(await call('POST', `/v1/alerts/${alert.id}/resolve`, mgr.token), 403);
  const askResolve = expect(await call('POST', `/v1/alerts/${alert.id}/resolve`, it.token), 202).change;
  assert.equal(askResolve.resource, 'alert'); assert.equal(askResolve.target_id, alert.id);
  expect(await call('POST', `/v1/changes/${askResolve.id}/approve`, admin), 200);
  const resolved = expect(await call('GET', `/v1/alerts?q=${encodeURIComponent(`MAC-${run}`)}`, admin), 200).items.find((a: any) => a.id === alert.id);
  assert.ok(resolved.resolved_at); assert.equal(resolved.resolved_by_name, me.name, 'attributed to the approving admin');
  assert.ok(expect(await call('GET', `/v1/alerts?q=${encodeURIComponent(`MAC-${run}`)}`, mgr.token), 200).items.some((a: any) => a.id === alert.id));
  assert.ok(expect(await call('GET', `/v1/alerts?q=${encodeURIComponent(`Ada ${run}`)}`, admin), 200).items.length >= 1);
  assert.equal(expect(await call('GET', '/v1/alerts?q=%25no-such-thing_', admin), 200).items.length, 0);
  assert.equal(expect(await call('GET', `/v1/devices/${dev.device_id}`, admin), 200).status, 'online');
  ok('devices: tamper status, badges, alerts feed, resolve');

  // presence: no input reported → the device's own bucket from 30 min ago counts (lookback 35 min)
  const presence = async () => expect(await call('GET', `/v1/employees/${ada.id}`, admin), 200).presence;
  const beat = async (idle: unknown) =>
    expect(await call('POST', '/v1/agents/heartbeat', undefined, { agent_version: '1.0.0', input_idle_seconds: idle }, dk), 200);
  assert.equal(await presence(), 'active', 'bucket fallback');
  await beat(900); assert.equal(await presence(), 'idle', 'input 15 min ago beats the bucket');
  await beat(10); assert.equal(await presence(), 'active', 'input 10 s ago');
  await beat(-5); assert.equal(await presence(), 'active', 'invalid value ignored: back to the bucket');
  ok('presence: reported input, bucket fallback, invalid input_idle_seconds ignored');

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
  const q = `from=${today}&to=${today}&employee_id=${ada.id}`;
  const apps = expect(await call('GET', `/v1/reports/apps?${q}`, mgr.token), 200);
  assert.equal(apps.apps.find((a: any) => a.app_name === `Code${run}`)?.category, 'productive');
  const prod = expect(await call('GET', `/v1/reports/productivity?${q}`, admin), 200);
  // tracked counts both sessions; the split counts browser time by site (Safari replaced by its visit)
  assert.deepEqual([prod.tracked_seconds, prod.productive_seconds, prod.unproductive_seconds], [3000, 1800, 1200]);
  const act = expect(await call('GET', `/v1/reports/activity?${q}`, admin), 200);
  assert.equal(act.activity_percent, 75); assert.equal(act.idle_seconds, 300); assert.equal(act.hours.length, 24);
  const byDay = expect(await call('GET', `/v1/reports/productivity?${q}&group_by=week`, admin), 200);
  assert.equal(byDay.periods.length, 1); assert.equal(byDay.periods[0].tracked_seconds, 3000);
  expect(await call('GET', `/v1/reports/activity?${q}&group_by=year`, admin), 422);
  expect(await call('GET', `/v1/reports/apps?${q}`, it.token), 403);
  expect(await call('GET', `/v1/reports/apps?from=${today}&to=${today}&employee_id=${bob.id}`, mgr.token), 404);
  expect(await call('GET', `/v1/reports/apps?from=2026-02-30&to=${today}`, admin), 422);
  const daysAgo = (n: number) => new Date(Date.parse(today + 'T00:00:00Z') - n * 86400_000).toISOString().slice(0, 10);
  expect(await call('GET', `/v1/reports/productivity?from=${daysAgo(89)}&to=${today}`, admin), 200); // 90 days
  expect(await call('GET', `/v1/reports/productivity?from=${daysAgo(90)}&to=${today}`, admin), 422); // 91 days
  expect(await call('GET', `/v1/employees/${ada.id}/screenshots?from=${daysAgo(90)}&to=${today}`, admin), 422);
  const shots = `/v1/employees/${ada.id}/screenshots?from=${today}&to=${today}`;
  const day = expect(await call('GET', shots, admin), 200), hrs = expect(await call('GET', `${shots}&start=00:00&end=24:00`, admin), 200);
  assert.equal(hrs.total, day.total, 'the whole day as hours lists the same screenshots');
  expect(await call('GET', `${shots}&start=09:00&end=12:00`, admin), 200);
  for (const h of ['start=09:00', 'end=12:00', 'start=12:00&end=09:00', 'start=09:00&end=09:00', 'start=9:00&end=12:00', 'start=24:00&end=24:00', 'start=09:00&end=24:01'])
    expect(await call('GET', `${shots}&${h}`, admin), 422, 'VALIDATION_FAILED');
  const cal = expect(await call('GET', `/v1/employees/${ada.id}/calendar?view=week&date=${today}`, admin), 200);
  assert.equal(cal.find((r: any) => r.date === today).tracked_seconds, 3000);
  const exp = await call('GET', `/v1/exports/app-sessions.csv?${q}`, admin);
  assert.equal(exp.status, 200); assert.match(exp.headers.get('content-type')!, /text\/csv/); assert.match(exp.json, /productive/);
  const dash = expect(await call('GET', '/v1/dashboard', admin), 200);
  assert.ok(dash.seats && dash.today && dash.devices);
  const dashIt = expect(await call('GET', '/v1/dashboard', it.token), 200);
  assert.ok(!('today' in dashIt) && !('seats' in dashIt));
  ok('reports: apps, productivity split, activity, calendar, CSV export, dashboard by role');

  // usage summaries (summarize-usage): reports answer the same before and after the job; late batches show at once
  expect(await call('POST', '/cron/usage-summary'), 401, 'UNAUTHENTICATED');
  expect(await call('POST', '/cron/usage-summary', undefined, undefined, { 'x-cron-secret': 'wrong' }), 401, 'UNAUTHENTICATED');
  const cron = process.env.CRON_SECRET;
  if (cron) {
    const cs = { 'x-cron-secret': cron };
    expect(await call('POST', '/cron/no-such-job', undefined, undefined, cs), 404, 'NOT_FOUND');
    const past = daysAgo(2), at = Date.parse(past + 'T06:00:00Z'); // 12:00 in Dhaka
    const lateBatch = async (start: number, secs: number, app: string) => {
      const id = randomUUID();
      expect(await call('POST', '/v1/agents/activity', undefined, {
        batch_id: id,
        app_sessions: [{ session_user: 'ada', bundle_id: 'x', app_name: app, process_name: 'p', started_at: start, ended_at: start + secs * 1000, duration_seconds: secs }],
        url_visits: [{ session_user: 'ada', browser: 'safari', url: `https://docs-${run}.example/`, domain: `docs-${run}.example`, visited_at: start, duration_seconds: secs }],
        activity_buckets: [{ bucket_start: start, active_samples: 2, total_samples: 4 }],
        idle_intervals: [{ session_user: 'ada', started_at: start + 1000, ended_at: start + 61_500 }],
      }, { ...dk, 'idempotency-key': id }), 200);
    };
    await lateBatch(at, 900, `Code${run}`);
    await lateBatch(at + 3600_000, 600, 'Safari');
    // a timezone change drops the company's summaries, so the first reading is from raw rows
    expect(await call('PATCH', '/v1/company/settings', admin, { timezone: 'UTC' }), 200);
    expect(await call('PATCH', '/v1/company/settings', admin, { timezone: 'Asia/Dhaka' }), 200);
    const w = `from=${daysAgo(6)}&to=${today}`;
    const monday = daysAgo((new Date(past + 'T00:00:00Z').getUTCDay() + 6) % 7 + 2);
    const reads = [`/v1/reports/productivity?${w}&group_by=day`, `/v1/reports/activity?${w}&group_by=week`, `/v1/reports/apps?${w}&limit=100`,
      `/v1/reports/websites?${w}&limit=100`, `/v1/reports/apps?${w}&category=productive`, `/v1/reports/productivity?${w}&employee_id=${ada.id}`,
      `/v1/employees/${ada.id}/calendar?view=month&date=${past}`, `/v1/employees/${ada.id}/timesheet?week=${monday}`, `/v1/exports/daily-summaries.csv?${w}`];
    const snap = async () => Promise.all(reads.map(async (u) => (await call('GET', u, admin)).json));
    const before = await snap();
    let run1: any;
    do run1 = expect(await call('POST', '/cron/usage-summary', undefined, undefined, cs), 200); while (run1.more || run1.skipped);
    assert.ok(run1.rows_affected.usage_days >= 1, 'days were summarized');
    assert.deepEqual(await snap(), before, 'same responses from summaries');
    const again = expect(await call('POST', '/cron/usage-summary', undefined, undefined, cs), 200);
    assert.deepEqual(again.rows_affected, {}); assert.equal(again.more, false);
    const one = `/v1/reports/productivity?from=${past}&to=${past}&employee_id=${ada.id}`;
    const was = expect(await call('GET', one, admin), 200).tracked_seconds;
    await lateBatch(at + 7200_000, 300, `Code${run}`);
    assert.equal(expect(await call('GET', one, admin), 200).tracked_seconds, was + 300, 'a late batch shows at once');
    ok('usage summaries: cron secret, same reports before and after, late batch, timezone change');
  } else console.log('skip usage summaries: CRON_SECRET not set');

  expect(await call('DELETE', `/v1/employees/${ada.id}`, admin), 409, 'EMPLOYEE_HAS_DEVICES');
  expect(await call('POST', `/v1/devices/${dev.device_id}/release`, mgr.token), 403);
  const askRelease = expect(await call('POST', `/v1/devices/${dev.device_id}/release`, it.token), 202).change;
  assert.match(askRelease.summary, /^Release computer \S+/);
  expect(await call('POST', '/v1/agents/heartbeat', undefined, { agent_version: '1.0.0' }, dk), 200); // not released yet
  assert.equal(expect(await call('POST', `/v1/changes/${askRelease.id}/approve`, admin), 200).change.status, 'approved');
  expect(await call('POST', '/v1/agents/heartbeat', undefined, { agent_version: '1.0.0' }, dk), 401, 'DEVICE_RELEASED');
  expect(await call('POST', `/v1/devices/${dev.device_id}/release`, it.token), 409, 'CONFLICT');
  expect(await call('POST', `/v1/devices/${dev.device_id}/deactivate`, admin), 404); // B35: no deactivate route
  assert.equal(expect(await call('GET', `/v1/devices/${dev.device_id}`, it.token), 200).status, 'released');
  // B36: the uninstaller after a release still records it; the key is then gone.
  expect(await call('POST', '/v1/agents/uninstall', undefined, undefined, dk), 204);
  const gone = expect(await call('GET', `/v1/devices/${dev.device_id}`, it.token), 200);
  assert.equal(gone.status, 'uninstalled'); assert.ok(gone.uninstalled_at && gone.released_at);
  assert.ok(expect(await call('GET', '/v1/devices?status=uninstalled', it.token), 200).some((x: any) => x.id === dev.device_id));
  expect(await call('POST', '/v1/agents/uninstall', undefined, undefined, dk), 401, 'DEVICE_REVOKED');
  expect(await call('POST', `/v1/devices/${dev.device_id}/release`, it.token), 409, 'CONFLICT');
  expect(await call('DELETE', `/v1/employees/${ada.id}`, admin), 204);
  expect(await call('PATCH', `/v1/employees/${ada.id}`, admin, { name: 'x' }), 409);
  ok('release frees the employee; uninstall after release; archive; archived is read-only');

  // restore (D46): a returning employee is restored, not created again
  const adaMail = `ada-${run}@example.test`;
  const reImp = await call('POST', '/v1/employees/import', admin, `Ada back,${adaMail.toUpperCase()},,\n`, { 'content-type': 'text/csv' });
  expect(reImp, 422); assert.deepEqual(reImp.json.lines, [1]); assert.equal(reImp.json.archived[0].employee_id, ada.id);
  expect(await call('POST', `/v1/employees/${ada.id}/restore`, it.token), 403);
  expect(await call('POST', `/v1/employees/${ada.id}/restore`, mgr.token), 403);
  const ada2 = expect(await call('POST', '/v1/employees', admin, { name: 'Ada two', email: adaMail }), 201); // the email is free while archived
  expect(await call('POST', `/v1/employees/${ada.id}/restore`, admin), 409, 'CONFLICT');
  assert.ok(expect(await call('GET', `/v1/employees/${ada.id}`, admin), 200).archived_at);
  expect(await call('DELETE', `/v1/employees/${ada2.id}`, admin), 204);
  const back = expect(await call('POST', `/v1/employees/${ada.id}/restore`, admin), 200);
  assert.equal(back.id, ada.id); assert.equal(back.archived_at, null); assert.equal(back.presence, 'no_device');
  expect(await call('PATCH', `/v1/employees/${ada.id}`, admin, { department: 'Back' }), 200);
  assert.equal(expect(await call('POST', `/v1/employees/${ada.id}/restore`, admin), 200).archived_at, null); // not archived: unchanged
  expect(await call('DELETE', `/v1/employees/${ada.id}`, admin), 204);
  expect(await call('POST', `/v1/employees/${ada.id}/restore`, admin, { email: 'nope' }), 422);
  assert.equal(expect(await call('POST', `/v1/employees/${ada.id}/restore`, admin, { email: `ada.new-${run}@example.test` }), 200).email, `ada.new-${run}@example.test`);
  ok('restore: same id, email clash 409, new email, roles, import refuses archived email');

  expect(await call('DELETE', `/v1/team/users/${mgr.id}`, admin), 204);
  expect(await call('GET', '/v1/me', mgr.token), 401, 'UNAUTHENTICATED');
  // password reset (self-service), for the it_admin
  expect(await call('POST', '/v1/auth/password-reset/request', undefined, { email: `nobody-${run}@example.test` }), 204);
  expect(await call('POST', '/v1/auth/password-reset/request', undefined, { email: it.email }), 204);
  await new Promise((r) => setTimeout(r, 300)); // the email is sent after the answer
  const resetToken = decodeURIComponent(inviteToken(it.email));
  expect(await call('POST', '/v1/auth/password-reset/confirm', undefined, { token: resetToken, new_password: 'short' }), 422);
  expect(await call('POST', '/v1/auth/password-reset/confirm', undefined, { token: 'wbr_nope', new_password: 'a new long password' }), 404, 'PASSWORD_RESET_INVALID');
  expect(await call('POST', '/v1/auth/password-reset/confirm', undefined, { token: resetToken, new_password: 'a new long password' }), 200);
  expect(await call('POST', '/v1/auth/password-reset/confirm', undefined, { token: resetToken, new_password: 'a new long password' }), 410, 'PASSWORD_RESET_EXPIRED');
  expect(await call('GET', '/v1/me', it.token), 401);
  it.token = expect(await call('POST', '/v1/auth/login', undefined, { email: it.email, password: 'a new long password' }), 200).token;
  // A password change uses up reset links asked for before it.
  expect(await call('POST', '/v1/auth/password-reset/request', undefined, { email: it.email }), 204);
  await new Promise((r) => setTimeout(r, 300));
  const stale = decodeURIComponent(inviteToken(it.email));
  expect(await call('POST', '/v1/auth/password', it.token, { current_password: 'a new long password', new_password: 'another long password' }), 200);
  expect(await call('POST', '/v1/auth/password-reset/confirm', undefined, { token: stale, new_password: 'a third long password' }), 410, 'PASSWORD_RESET_EXPIRED');
  ok('password reset: always 204, single use, ends sessions, dies on a password change');

  expect(await call('POST', '/v1/auth/logout', it.token), 204);
  expect(await call('GET', '/v1/me', it.token), 401);
  ok('removed user and logged-out session lose access');
  await round4(admin, login.user.company.id);
  if (process.env.STAFF1_EMAIL) await staff();
  console.log('\nall portal checks passed against', BASE);
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
