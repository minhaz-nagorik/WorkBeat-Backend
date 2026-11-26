// alertDigestJob: one email per due company, only its alert types, at most one interval back, then not due.
// Runs in one transaction that is rolled back. Emails go to STORAGE_DIR/outbox, so it skips when RESEND_API_KEY is set.
// Usage: RESEND_API_KEY= node --env-file=.env --test dist/alert-digest.test.js
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from 'pg';
import { alertDigestJob } from './alert-digest';
import type { JobTx } from './usage';

const url = process.env.DATABASE_URL;
const skip = !url ? 'DATABASE_URL not set' : process.env.RESEND_API_KEY ? 'RESEND_API_KEY set: would send real email' : false;

test('alert digest mails due companies their new alerts once', { skip }, async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  const run = Date.now().toString(36), admin = `digest-${run}@example.test`, off = `digest-off-${run}@example.test`;
  const outbox = join(process.env.STORAGE_DIR ?? './storage', 'outbox');
  const mails = () => { try { return readdirSync(outbox).filter((n) => n.includes(run)); } catch { return []; } };
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.scope', 'system', true)");
    const { rows: [co] } = await c.query(
      `INSERT INTO companies (name, slug, status, uninstall_token_hash, uninstall_token_ciphertext, notice_text, alert_email)
       VALUES ('D', $1, 'active', $1, '\\x00', 'n', '{"roles": ["company_admin"], "types": ["hosts_modified"], "delivery": "hourly"}') RETURNING id`, [`d-${run}`]);
    await c.query("INSERT INTO licenses (company_id, key_hash, key_ciphertext, key_last4, plan, seat_limit) VALUES ($1, $2, '\\x00', 'AAAA', 'starter', 5)", [co.id, `k-${run}`]);
    await c.query("INSERT INTO users (email, name, role, company_id) VALUES ($1, 'A', 'company_admin', $3), ($2, 'B', 'company_admin', $3)", [admin, off, co.id]);
    await c.query('UPDATE users SET disabled_at = now() WHERE email = $1', [off]);
    const { rows: [e] } = await c.query("INSERT INTO employees (company_id, name, email) VALUES ($1, 'E', $2) RETURNING id", [co.id, `e-${run}@example.test`]);
    const { rows: [d] } = await c.query(
      `INSERT INTO devices (company_id, employee_id, key_hash, hostname, os, os_version, arch, hardware_id, agent_version)
       VALUES ($1, $2, $3, 'mac-1', 'macos', '14', 'arm64', $3, '1.0.0') RETURNING id`, [co.id, e.id, `hw-${run}`]);
    const ev = (type: string, ago: string) => c.query(
      `INSERT INTO tamper_events (id, company_id, device_id, hostname, event_type, detail, occurred_at, received_at)
       VALUES (gen_random_uuid(), $1, $2, 'mac-1', $3, '{}', now() - $4::interval, now() - $4::interval)`, [co.id, d.id, type, ago]);
    await ev('hosts_modified', '10 minutes');
    await ev('config_changed', '10 minutes'); // type not chosen
    await ev('clock_tampered', '3 hours');    // older than one interval
    await ev('hosts_modified', '3 hours');

    const tx: JobTx = async (fn) => ({ value: await fn(c as any) });
    await alertDigestJob(tx, {});
    for (let i = 0; i < 20 && !mails().length; i++) await new Promise((r) => setTimeout(r, 50));
    const got = mails();
    assert.equal(got.length, 1, 'one email, not to the disabled admin');
    assert.ok(got[0].includes(admin.replace(/[^\w.@-]/g, '_')));
    const m = JSON.parse(readFileSync(join(outbox, got[0]), 'utf8'));
    assert.equal(m.subject, 'WorkBeat alert: 1 tamper event in the last hour');
    assert.match(m.text, /^• Website blocking changed on mac-1 \(E\), \d{1,2} \w{3} \d{4}, \d{1,2}:\d{2} [AP]M$/m);
    assert.doesNotMatch(m.text, /settings edited|clock changed/);
    assert.ok((await c.query('SELECT alert_digest_sent_at FROM companies WHERE id = $1', [co.id])).rows[0].alert_digest_sent_at);

    await ev('hosts_modified', '1 minute');
    await alertDigestJob(tx, {});
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(mails().length, 1, 'not due again within the hour');
  } finally {
    await c.query('ROLLBACK');
    await c.end();
    for (const n of mails()) rmSync(join(outbox, n));
  }
});
