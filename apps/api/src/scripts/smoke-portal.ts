// End-to-end check of the portal API against a running local API.
// Usage: ADMIN_EMAIL=… ADMIN_PASSWORD=… [BASE_URL=http://localhost:3000] pnpm smoke:portal
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
  const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
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

async function main() {
  expect(await call('POST', '/v1/auth/login', undefined, { email: process.env.ADMIN_EMAIL, password: 'wrong-password' }), 401, 'UNAUTHENTICATED');
  const login = expect(await call('POST', '/v1/auth/login', undefined, { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }), 200);
  const admin: string = login.token;
  const me = expect(await call('GET', '/v1/me', admin), 200);
  assert.equal(me.role, 'company_admin');
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
  expect(await call('POST', '/v1/employees', admin, { name: 'X', manager_user_id: it.id }), 422);
  expect(await call('POST', '/v1/employees', mgr.token, { name: 'X' }), 403);
  const mine = expect(await call('GET', '/v1/employees', mgr.token), 200);
  assert.ok(mine.some((e: any) => e.id === ada.id) && !mine.some((e: any) => e.id === bob.id));
  expect(await call('GET', `/v1/employees/${bob.id}`, mgr.token), 404, 'NOT_FOUND');
  const itList = expect(await call('GET', '/v1/employees', it.token), 200);
  assert.deepEqual(Object.keys(itList[0]).sort(), ['department', 'email', 'id', 'name']);
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
  expect(await call('GET', `/v1/employees/${ada.id}/monitoring-settings`, it.token), 403);
  const start = new Date(Date.now() + 86400_000), end = new Date(Date.now() + 2 * 86400_000);
  const pause = expect(await call('POST', `/v1/employees/${ada.id}/pauses`, admin, { starts_at: start.toISOString(), ends_at: end.toISOString(), reason: 'annual_leave' }), 201);
  assert.equal(pause.status, 'scheduled');
  expect(await call('POST', `/v1/employees/${ada.id}/pauses`, admin, { starts_at: start.toISOString(), ends_at: end.toISOString(), reason: 'personal' }), 409);
  expect(await call('PATCH', `/v1/employees/${ada.id}/pauses/${pause.id}`, admin, { ends_at: new Date(end.getTime() + 3600_000).toISOString() }), 200);
  expect(await call('POST', `/v1/employees/${ada.id}/pauses/${pause.id}/cancel`, admin), 200);
  expect(await call('POST', `/v1/employees/${ada.id}/pauses/${pause.id}/cancel`, admin), 409);
  ok('monitoring settings (tier rule) and pauses (overlap, extend, cancel)');

  // policy
  const dom = `blocked-${run}.example`;
  expect(await call('POST', '/v1/block-rules', it.token, { type: 'domain', pattern: dom.toUpperCase() }), 201);
  expect(await call('POST', '/v1/block-rules', it.token, { type: 'domain', pattern: dom }), 409);
  expect(await call('POST', '/v1/block-rules', it.token, { type: 'domain', pattern: 'https://x.com/a' }), 422);
  const fromRegex = expect(await call('POST', '/v1/block-rules', admin, { type: 'regex', pattern: `^(www\\.)?(a-${run}\\.com|b-${run}\\.com)/games.*$` }), 201);
  assert.deepEqual(fromRegex.map((r: any) => r.pattern), [`a-${run}.com/games`, `b-${run}.com/games`]);
  expect(await call('POST', '/v1/block-rules', admin, { type: 'regex', pattern: '.*evil.*' }), 422);
  expect(await call('POST', '/v1/block-rules', mgr.token, { type: 'domain', pattern: 'x.com' }), 403);
  expect(await call('GET', '/v1/block-rules', mgr.token), 200);
  const sd = expect(await call('POST', '/v1/sensitive-domains', admin, { pattern: `bank-${run}.example` }), 201);
  expect(await call('POST', '/v1/sensitive-domains', admin, { pattern: '*.bank' }), 422);
  expect(await call('GET', '/v1/sensitive-domains', it.token), 403);
  expect(await call('DELETE', `/v1/sensitive-domains/${sd.id}`, admin), 204);
  expect(await call('POST', '/v1/productivity-rules', admin, { match_type: 'app', pattern: `Code${run}`, category: 'productive' }), 201);
  expect(await call('POST', '/v1/productivity-rules', admin, { match_type: 'domain', pattern: `fun-${run}.example`, category: 'unproductive' }), 201);
  const n0 = expect(await call('GET', '/v1/settings/notice', admin), 200);
  const n1 = expect(await call('PUT', '/v1/settings/notice', admin, { notice_text: n0.notice_text + ` (${run})` }), 200);
  assert.equal(n1.notice_version, n0.notice_version + 1);
  assert.equal(expect(await call('PUT', '/v1/settings/notice', admin, { notice_text: n1.notice_text }), 200).notice_version, n1.notice_version);
  ok('block rules (domain, regex → url), sensitive domains, productivity rules, notice version');

  // licence, settings, setup
  const lic = expect(await call('GET', '/v1/license', it.token), 200);
  const key = expect(await call('POST', '/v1/license/reveal', it.token), 200).key;
  assert.ok(key.endsWith(lic.key_masked.slice(-4)));
  expect(await call('POST', '/v1/license/reveal', mgr.token), 403);
  expect(await call('POST', '/v1/license/uninstall-token/reveal', admin), 200);
  expect(await call('PATCH', '/v1/company/settings', admin, { timezone: 'Not/AZone' }), 422);
  expect(await call('PATCH', '/v1/company/settings', admin, { timezone: 'Asia/Dhaka', idle_threshold_seconds: 300 }), 200);
  expect(await call('PATCH', '/v1/company/settings', it.token, { name: 'x' }), 403);
  expect(await call('POST', '/v1/company/setup/steps', admin, { step: 'copy_license_key' }), 204);
  assert.ok(expect(await call('GET', '/v1/company/setup', it.token), 200).find((s: any) => s.step === 'copy_license_key').done);
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
  expect(await call('GET', '/v1/devices', mgr.token), 403);
  expect(await call('GET', '/v1/rollout', admin), 200);
  const feed = expect(await call('GET', '/v1/alerts?state=open', mgr.token), 200);
  const alert = feed.items.find((a: any) => a.device_id === dev.device_id);
  assert.ok(alert);
  expect(await call('POST', `/v1/alerts/${alert.id}/resolve`, mgr.token), 403);
  assert.ok(expect(await call('POST', `/v1/alerts/${alert.id}/resolve`, it.token), 200).resolved_at);
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
  expect(await call('POST', `/v1/devices/${dev.device_id}/release`, it.token), 200);
  expect(await call('POST', '/v1/agents/heartbeat', undefined, { agent_version: '1.0.0' }, dk), 401, 'DEVICE_RELEASED');
  expect(await call('POST', `/v1/devices/${dev.device_id}/release`, it.token), 409, 'CONFLICT');
  expect(await call('POST', `/v1/devices/${dev.device_id}/deactivate`, it.token), 409, 'CONFLICT');
  expect(await call('DELETE', `/v1/employees/${ada.id}`, admin), 204);
  expect(await call('PATCH', `/v1/employees/${ada.id}`, admin, { name: 'x' }), 409);
  ok('release frees the employee; archive; archived is read-only');

  expect(await call('DELETE', `/v1/team/users/${mgr.id}`, admin), 204);
  expect(await call('GET', '/v1/me', mgr.token), 401, 'UNAUTHENTICATED');
  expect(await call('POST', '/v1/auth/logout', it.token), 204);
  expect(await call('GET', '/v1/me', it.token), 401);
  ok('removed user and logged-out session lose access');
  console.log('\nall portal checks passed against', BASE);
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
