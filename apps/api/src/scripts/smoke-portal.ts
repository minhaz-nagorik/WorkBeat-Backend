// End-to-end check of the portal API against a running local API.
// Usage: ADMIN_EMAIL=… ADMIN_PASSWORD=… [STAFF1_EMAIL=… STAFF1_PASSWORD=… STAFF_TARGET_SLUG=…]
//        [BASE_URL=http://localhost:3000] pnpm smoke:portal
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
async function join_(admin: string, role: string) {
  const email = `${role}-${run}@example.test`;
  expect(await call('POST', '/v1/team/invitations', admin, { email, role }), 201);
  const t = decodeURIComponent(inviteToken(email));
  const look = expect(await call('POST', '/v1/invitations/lookup', undefined, { token: t }), 200);
  assert.equal(look.role, role);
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

  const slug = process.env.STAFF_TARGET_SLUG;
  if (slug) {
    const co = expect(await call('GET', `/v1/staff/companies?q=${slug}`, t), 200).items.find((x: any) => x.slug === slug);
    assert.ok(co, 'target company found by q');
    assert.equal(expect(await call('POST', `/v1/staff/companies/${co.id}/suspend`, t), 200).suspended_reason, 'staff');
    assert.notEqual(expect(await call('POST', `/v1/staff/companies/${co.id}/restore`, t), 200).status, 'suspended');
    assert.equal(expect(await call('PATCH', `/v1/staff/companies/${co.id}`, t, { expired_blocking_grace_days: 14 }), 200).expired_blocking_grace_days, 14);
    expect(await call('PATCH', `/v1/staff/companies/${co.id}`, t, { expired_blocking_grace_days: 366 }), 422);
    expect(await call('PATCH', `/v1/staff/companies/${co.id}/license`, t, { plan: 'growth', seat_limit: 5 }), 422);
    const ent = expect(await call('PATCH', `/v1/staff/companies/${co.id}/license`, t, { plan: 'enterprise', seat_limit: null }), 200);
    assert.equal(ent.plan, 'enterprise'); assert.equal(ent.seat_limit, null);
    const re = await call('POST', `/v1/staff/companies/${co.id}/license/reissue`, t);
    assert.match(expect(re, 200).key, /^WB-[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
    assert.equal(re.headers.get('cache-control'), 'no-store');
    expect(await call('POST', '/v1/license/validate', undefined, {}, { 'x-license-key': re.json.data.key }), 200);
    ok('staff company actions: suspend, restore, grace, enterprise, reissue');
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
async function round4(admin: string) {
  const host = `smoke-${run}.example.com`;
  const d = expect(await call('PUT', '/v1/company/custom-domain', admin, { domain: host.toUpperCase() + '.' }), 200);
  assert.equal(d.domain, host); assert.equal(d.status, 'pending'); assert.equal(d.txt_name, `_workbeat.${host}`); assert.match(d.txt_value, /^verify-/);
  assert.equal(expect(await call('PUT', '/v1/company/custom-domain', admin, { domain: host }), 200).txt_value, d.txt_value, 'same domain keeps its token');
  expect(await call('PUT', '/v1/company/custom-domain', admin, { domain: 'WORKBEAT.IO' }), 422);
  expect(await call('GET', `/v1/hosts/resolve?host=${host}`), 404, 'NOT_FOUND');
  expect(await call('DELETE', '/v1/company/custom-domain', admin), 204);
  assert.equal(expect(await call('GET', '/v1/company/custom-domain', admin), 200), null);
  const slug = expect(await call('GET', '/v1/company/settings', admin), 200).slug;
  assert.equal(expect(await call('GET', `/v1/hosts/resolve?host=${slug.toUpperCase()}.workbeat.io`), 200).slug, slug);
  expect(await call('GET', `/v1/hosts/resolve?host=x.${slug}.workbeat.io`), 404, 'NOT_FOUND');
  ok('custom domain: set, same again, refuse workbeat.io, delete; hosts/resolve');

  assert.deepEqual((await call('PATCH', '/v1/company/settings', admin, { alert_email: { roles: [], types: [], delivery: 'instant' } })).json.fields, ['alert_email.roles']);
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

  const mgr = await join_(admin, 'manager');
  const it = await join_(admin, 'it_admin');
  expect(await call('POST', '/v1/team/invitations', admin, { email: mgr.email, role: 'manager' }), 409, 'CONFLICT');
  expect(await call('POST', '/v1/team/invitations', admin, { email: `x-${run}@example.test`, role: 'super_admin' }), 422);
  expect(await call('GET', '/v1/team', mgr.token), 403, 'FORBIDDEN');
  const team = expect(await call('GET', '/v1/team', admin), 200);
  assert.ok(team.users.some((u: any) => u.id === mgr.id));
  expect(await call('PATCH', `/v1/team/users/${me.id}`, admin, { role: 'manager' }), team.users.filter((u: any) => u.role === 'company_admin').length > 1 ? 200 : 409);
  ok('invitations → manager and it_admin accounts; last-admin guard');

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
  const csv = `name,email,department,manager email\nCara ${run},cara-${run}@example.test,Sales,${mgr.email}\nAda again,ada-${run}@example.test,,\n`;
  const imp = expect(await call('POST', '/v1/employees/import', admin, csv, { 'content-type': 'text/csv' }), 201);
  assert.deepEqual([imp.created, imp.skipped], [1, 1]);
  const badImp = await call('POST', '/v1/employees/import', admin, `Dee,not-an-email,,\n,x@y.test,,\n`, { 'content-type': 'text/csv' });
  expect(badImp, 422); assert.deepEqual(badImp.json.lines, [1, 2]);
  ok('employees: create, team scoping, it_admin fields, CSV import');

  // monitoring settings + pauses
  const all = { activity: true, app_usage: true, window_titles: false, website_visits: true };
  expect(await call('PUT', `/v1/employees/${ada.id}/monitoring-settings`, admin, { ...all, screenshot_interval_seconds: 600 }), 422);
  expect(await call('PUT', `/v1/employees/${ada.id}/monitoring-settings`, admin, { ...all, screenshot_interval_seconds: 1800 }), 200);
  expect(await call('PUT', `/v1/employees/${ada.id}/monitoring-settings`, mgr.token, { ...all, screenshot_interval_seconds: 0 }), 403);
  expect(await call('GET', `/v1/employees/${ada.id}/monitoring-settings`, it.token), 200); // round 6: it_admin reads settings
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
  expect(await call('DELETE', `/v1/changes/${mine2.id}`, admin), 403);
  expect(await call('DELETE', `/v1/changes/${mine2.id}`, it.token), 204);
  expect(await call('DELETE', `/v1/changes/${mine2.id}`, it.token), 409, 'CONFLICT');
  expect(await call('GET', '/v1/changes', mgr.token), 403);
  const itChanges = expect(await call('GET', '/v1/changes', it.token), 200);
  assert.deepEqual(itChanges.slice(0, 3).map((x: any) => x.status), ['cancelled', 'rejected', 'approved']);
  assert.ok(expect(await call('GET', '/v1/changes?status=pending', admin), 200).every((x: any) => x.status === 'pending'));
  const delay = expect(await call('POST', '/v1/employees', it.token, { name: `Late ${run}`, email: `late-${run}@example.test` }), 202).change;
  expect(await call('POST', '/v1/employees', admin, { name: `Late ${run}`, email: `late-${run}@example.test` }), 201);
  const failed = expect(await call('POST', `/v1/changes/${delay.id}/approve`, admin), 200).change;
  assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'CONFLICT');
  ok('change approvals: 202 pending, validated at once, approve applies, reject, cancel, failed replay');
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
  const n1 = expect(await call('PUT', '/v1/settings/notice', admin, { notice_text: n0.notice_text + ` (${run})` }), 200);
  assert.equal(n1.notice_version, n0.notice_version + 1);
  assert.equal(expect(await call('PUT', '/v1/settings/notice', admin, { notice_text: n1.notice_text }), 200).notice_version, n1.notice_version);
  ok('block rules (domain, regex → url), sensitive domains, productivity rules, notice version');

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
  expect(await call('POST', '/v1/company/setup/steps', admin, { step: 'copy_license_key' }), 204);
  assert.ok(expect(await call('GET', '/v1/company/setup', admin), 200).find((s: any) => s.step === 'copy_license_key').done);
  expect(await call('GET', '/v1/company/setup', it.token), 403);
  expect(await call('GET', '/v1/company/status', mgr.token), 200);
  expect(await call('GET', '/v1/billing', admin), 200);
  ok('licence reveal, settings (timezone check), setup, status, billing');

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

  const devices = expect(await call('GET', '/v1/devices', it.token), 200);
  const d = devices.find((x: any) => x.id === dev.device_id);
  assert.equal(d.status, 'tamper'); assert.ok(d.badges.includes('permission_pending'));
  assert.ok('released_at' in d && 'deactivated_at' in d);
  const adaNow = expect(await call('GET', `/v1/employees/${ada.id}`, mgr.token), 200);
  assert.equal(adaNow.presence, 'tamper'); assert.equal(adaNow.devices[0].id, dev.device_id);
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
  const cal = expect(await call('GET', `/v1/employees/${ada.id}/calendar?view=week&date=${today}`, admin), 200);
  assert.equal(cal.find((r: any) => r.date === today).tracked_seconds, 3000);
  const exp = await call('GET', `/v1/exports/app-sessions.csv?${q}`, admin);
  assert.equal(exp.status, 200); assert.match(exp.headers.get('content-type')!, /text\/csv/); assert.match(exp.json, /productive/);
  const dash = expect(await call('GET', '/v1/dashboard', admin), 200);
  assert.ok(dash.seats && dash.today && dash.devices);
  const dashIt = expect(await call('GET', '/v1/dashboard', it.token), 200);
  assert.ok(!('today' in dashIt) && !('seats' in dashIt));
  ok('reports: apps, productivity split, activity, calendar, CSV export, dashboard by role');

  expect(await call('DELETE', `/v1/employees/${ada.id}`, admin), 409, 'EMPLOYEE_HAS_DEVICES');
  expect(await call('POST', `/v1/devices/${dev.device_id}/release`, mgr.token), 403);
  const askRelease = expect(await call('POST', `/v1/devices/${dev.device_id}/release`, it.token), 202).change;
  assert.match(askRelease.summary, /^Release computer \S+/);
  expect(await call('POST', '/v1/agents/heartbeat', undefined, { agent_version: '1.0.0' }, dk), 200); // not released yet
  assert.equal(expect(await call('POST', `/v1/changes/${askRelease.id}/approve`, admin), 200).change.status, 'approved');
  expect(await call('POST', '/v1/agents/heartbeat', undefined, { agent_version: '1.0.0' }, dk), 401, 'DEVICE_RELEASED');
  expect(await call('POST', `/v1/devices/${dev.device_id}/release`, it.token), 409, 'CONFLICT');
  expect(await call('POST', `/v1/devices/${dev.device_id}/deactivate`, it.token), 409, 'CONFLICT');
  expect(await call('DELETE', `/v1/employees/${ada.id}`, admin), 204);
  expect(await call('PATCH', `/v1/employees/${ada.id}`, admin, { name: 'x' }), 409);
  ok('release frees the employee; archive; archived is read-only');

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
  ok('password reset: always 204, single use, ends sessions');

  expect(await call('POST', '/v1/auth/logout', it.token), 204);
  expect(await call('GET', '/v1/me', it.token), 401);
  ok('removed user and logged-out session lose access');
  await round4(admin);
  if (process.env.STAFF1_EMAIL) await staff();
  console.log('\nall portal checks passed against', BASE);
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
