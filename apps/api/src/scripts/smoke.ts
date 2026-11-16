// End-to-end check of the agent contract against a running API (local or tunnel).
// Usage: LICENSE_KEY=WB-... [BASE_URL=http://localhost:3000] pnpm smoke
// Enrolls one throwaway device (takes a seat, deactivated at the end).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const LICENSE = process.env.LICENSE_KEY ?? '';

async function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const r = await fetch(path.startsWith('http') ? path : BASE + path, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, headers: r.headers, json: text ? JSON.parse(text) : null };
}
function step(name: string) { console.log('ok', name); }

async function main() {
  assert.ok(LICENSE, 'LICENSE_KEY is required');
  let r = await call('GET', '/health');
  assert.equal(r.status, 200); assert.ok(r.headers.get('date')); assert.ok(r.headers.get('x-request-id'));
  step('health');

  r = await call('POST', '/v1/license/validate', { 'x-license-key': 'WB-WRONG' }, {});
  assert.equal(r.json.code, 'LICENSE_NOT_FOUND'); step('unknown licence → 404');

  r = await call('POST', '/v1/license/validate', { 'x-license-key': LICENSE }, {});
  assert.equal(r.status, 200); assert.ok(r.json.data.employees.length > 0); assert.equal(r.json.data.enrollment_token, undefined);
  const employee = r.json.data.employees[0];
  step(`step 1: ${r.json.data.company_name}, ${r.json.data.employees.length} employees`);

  const issue = async () => (await call('POST', '/v1/license/validate', { 'x-license-key': LICENSE }, { employee_id: employee.id, os: 'macos', arch: 'arm64' })).json.data;
  const t1 = await issue();
  assert.match(t1.enrollment_token, /^wbe_/); step('step 2: token issued');

  r = await call('POST', '/v1/license/validate', { 'x-license-key': LICENSE }, { employee_id: employee.id, os: 'linux' });
  assert.equal(r.status, 400); step('step 2 linux → 400');

  const hw = 'smoke-' + randomUUID();
  const identity = { hostname: 'smoke-mac', os: 'macos', os_version: '15.1', arch: 'arm64', hardware_id: hw, agent_version: '1.0.0', enrolled_via: 'manual' };
  r = await call('POST', '/v1/devices/enroll', { authorization: 'Bearer wbe_nope' }, identity);
  assert.equal(r.json.code, 'ENROLLMENT_TOKEN_INVALID'); step('unknown token → 404');

  r = await call('POST', '/v1/devices/enroll', { authorization: `Bearer ${t1.enrollment_token}` }, { ...identity, hardware_id: '' });
  assert.equal(r.status, 400); step('empty hardware_id → 400, token unused');

  r = await call('POST', '/v1/devices/enroll', { authorization: `Bearer ${t1.enrollment_token}` }, identity);
  assert.equal(r.status, 201); assert.equal(r.json.data.outcome, 'new_binding'); assert.equal(r.json.data.notice_required, true);
  const deviceId: string = r.json.data.device_id;
  let key: string = r.json.data.device_key;
  step('enroll → new_binding');

  r = await call('POST', '/v1/devices/enroll', { authorization: `Bearer ${t1.enrollment_token}` }, identity);
  assert.equal(r.json.code, 'ENROLLMENT_TOKEN_EXHAUSTED'); step('token reuse → 403');

  const dk = () => ({ 'x-device-key': key });
  r = await call('POST', '/v1/agents/heartbeat', dk(), { agent_version: '1.0.0', store_bytes: -1 });
  assert.equal(r.status, 422); step('negative counter → 422');

  r = await call('GET', '/v1/agents/policy', dk());
  assert.equal(r.status, 200);
  const p = r.json.data;
  for (const f of ['policy_version', 'block_rules', 'sensitive_domains', 'screenshot_interval_seconds', 'idle_threshold_seconds',
    'min_agent_version', 'update_package_url', 'update_package_sha256', 'uninstall_token_hash', 'collection_notice',
    'monitoring_features', 'monitoring_pauses']) assert.ok(f in p, f);
  const etag = r.headers.get('etag')!;
  r = await call('GET', '/v1/agents/policy', { ...dk(), 'if-none-match': etag });
  assert.equal(r.status, 304); step('policy → 200 then 304');

  r = await call('POST', '/v1/agents/heartbeat', dk(), {
    agent_version: '1.0.0', policy_version: p.policy_version, helper_status: { '501': 'running' },
    permissions: { accessibility: 'granted', screen_recording: 'pending' }, store_bytes: 1024, uptime_seconds: 60,
    notice_version: p.collection_notice.version, notice_acknowledged_at: Date.now(),
  });
  assert.equal(r.status, 200); assert.equal(r.json.data.policy_version, p.policy_version); assert.equal(r.json.data.monitoring_pause, null);
  step('heartbeat + notice ack');

  // Shapes from the agents' specs: /api/v1 base, one helper_status value, counts by type, clock_suspect.
  r = await call('POST', '/api/v1/agents/heartbeat', dk(), {
    agent_version: '1.0.0', helper_status: 'no_session', dropped_records: { app_sessions: 2, url_visits: 0 }, screenshot_skips: { locked: 1 },
  });
  assert.equal(r.status, 200);
  const b2 = randomUUID();
  r = await call('POST', '/api/v1/agents/activity', { ...dk(), 'idempotency-key': b2 }, {
    batch_id: b2, app_sessions: [{ session_user: 'ada', bundle_id: 'x', app_name: 'X', started_at: Date.now() - 1000, ended_at: Date.now(), duration_seconds: 1, clock_suspect: true }],
  });
  assert.equal(r.status, 200); assert.equal(r.json.data.accepted.app_sessions, 1);
  r = await call('POST', '/api/v1/license/validate', { 'x-license-key': LICENSE.toLowerCase() }, {});
  assert.equal(r.status, 200);
  step('/api/v1 prefix, helper_status string, counts by type, clock_suspect, lower-case key');

  const now = Date.now(), batchId = randomUUID();
  const batch = {
    batch_id: batchId,
    app_sessions: [
      { session_user: 'ada', bundle_id: 'com.apple.Safari', app_name: 'Safari', process_name: 'Safari', window_title: '', started_at: now - 60_000, ended_at: now, duration_seconds: 60 },
      { session_user: 'ada', bundle_id: 'x', app_name: 'X', process_name: 'x', started_at: now - 9 * 86400_000, ended_at: now - 9 * 86400_000, duration_seconds: 0 },
    ],
    url_visits: [{ session_user: 'ada', browser: 'safari', url: 'https://example.com/', domain: 'example.com', visited_at: now - 30_000, duration_seconds: 30 }],
    activity_buckets: [
      { bucket_start: now - 60_000, active_samples: 3, total_samples: 6 },
      { bucket_start: now - 60_000, active_samples: 5, total_samples: 6 },
    ],
    idle_intervals: [],
  };
  r = await call('POST', '/v1/agents/activity', { ...dk(), 'idempotency-key': batchId }, batch);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.data.accepted, { app_sessions: 1, url_visits: 1, activity_buckets: 1, idle_intervals: 0 });
  assert.equal(r.json.data.dropped_out_of_window, 1);
  const first = r.json.data;
  r = await call('POST', '/v1/agents/activity', { ...dk(), 'idempotency-key': batchId }, batch);
  assert.deepEqual(r.json.data, first);
  r = await call('POST', '/v1/agents/activity', { ...dk(), 'idempotency-key': batchId }, { ...batch, idle_intervals: [{ session_user: 'ada', started_at: now - 1000, ended_at: now }] });
  assert.equal(r.json.code, 'IDEMPOTENCY_KEY_REUSED');
  r = await call('POST', '/v1/agents/activity', { ...dk(), 'idempotency-key': randomUUID() }, batch);
  assert.equal(r.status, 400);
  step('activity: stored once, window drop, bucket dedupe, reuse 409');

  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1000, 7), Buffer.from([0xff, 0xd9])]);
  const shotId = randomUUID();
  const shot = { id: shotId, captured_at: now, bytes: jpeg.length };
  r = await call('POST', '/v1/agents/screenshots', { ...dk(), 'idempotency-key': shotId }, shot);
  assert.equal(r.status, 201); assert.equal(r.json.data.status, 'pending');
  const uploadUrl: string = r.json.data.upload_url;
  r = await call('POST', `/v1/agents/screenshots/${shotId}/confirm`, dk());
  assert.equal(r.status, 422);
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: jpeg });
  assert.equal(put.status, 200);
  const badSig = await fetch(uploadUrl.replace(/sig=[^&]+/, 'sig=AAAA'), { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: jpeg });
  assert.equal(badSig.status, 403);
  r = await call('POST', `/v1/agents/screenshots/${shotId}/confirm`, dk());
  assert.equal(r.status, 200); assert.equal(r.json.data.status, 'uploaded');
  r = await call('POST', '/v1/agents/screenshots', { ...dk(), 'idempotency-key': shotId }, shot);
  assert.equal(r.status, 200); assert.equal(r.json.data.upload_url, null);
  r = await call('POST', `/v1/agents/screenshots/${randomUUID()}/confirm`, dk());
  assert.equal(r.json.code, 'NOT_FOUND');
  step('screenshot: request, PUT, confirm, repeat');

  const tamperId = randomUUID();
  const ev = { id: tamperId, event_type: 'hosts_modified', detail: { file: '/etc/hosts' }, occurred_at: now, repeat_count: 1 };
  r = await call('POST', '/v1/agents/tamper', dk(), ev);
  assert.equal(r.status, 201);
  r = await call('POST', '/v1/agents/tamper', dk(), { ...ev, repeat_count: 4 });
  assert.equal(r.status, 200);
  r = await call('POST', '/v1/agents/tamper', dk(), { ...ev, id: randomUUID(), event_type: 'offline' });
  assert.equal(r.status, 422);
  step('tamper: 201, repeat 200, offline 422');

  const t2 = await issue();
  const oldKey = key;
  r = await call('POST', '/v1/devices/enroll', { authorization: `Bearer ${t2.enrollment_token}` }, identity);
  assert.equal(r.status, 201); assert.equal(r.json.data.outcome, 'same_binding'); assert.equal(r.json.data.device_id, deviceId);
  key = r.json.data.device_key;
  r = await call('POST', '/v1/agents/heartbeat', { 'x-device-key': oldKey }, { agent_version: '1.0.0' });
  assert.equal(r.json.code, 'DEVICE_REVOKED');
  step('re-enroll → same_binding, old key revoked');

  r = await call('POST', `/v1/devices/${randomUUID()}/deactivate`, dk());
  assert.equal(r.json.code, 'FORBIDDEN');
  r = await call('POST', `/v1/devices/${deviceId}/deactivate`, dk());
  assert.equal(r.status, 204);
  r = await call('POST', '/v1/agents/heartbeat', dk(), { agent_version: '1.0.0' });
  assert.equal(r.json.code, 'DEVICE_REVOKED');
  step('deactivate → 204, then 401');
  console.log('\nall agent-contract checks passed against', BASE);
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
