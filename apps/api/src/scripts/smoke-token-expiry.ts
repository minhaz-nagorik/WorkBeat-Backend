// Checks /cron/token-expiry (cron-routes) against a real database: runs tokenExpiryJob as the API
// role in system scope, the way cron.controller does. Writes data, so it refuses any database whose
// name does not end in _test.
// Usage: ADMIN_DATABASE_URL=…/x_test DATABASE_URL=…/x_test pnpm smoke:token-expiry
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import type { Tx } from '../core';
import { tokenExpiryJob } from '../token-expiry';
import type { JobTx, Rows } from '../usage';

const HOUR = 3600 * 1000;
const ok = (name: string) => console.log('ok', name);

async function main() {
  const admin = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  const api = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  await admin.connect();
  const { rows: [db] } = await admin.query('SELECT current_database() AS n');
  if (!String(db.n).endsWith('_test')) throw new Error(`refusing to run against ${db.n}: name must end in _test`);

  // The cron runner, as in cron.controller.ts.
  const tx: JobTx = async (work) => {
    const c = (await api.connect()) as Tx;
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.scope', 'system', true)");
      const { rows: [l] } = await c.query("SELECT pg_try_advisory_xact_lock(hashtext('cron:token-expiry')) AS ok");
      const r = l.ok ? { value: await work(c) } : null;
      await c.query('COMMIT');
      return r;
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  };
  const run = async () => { const rows: Rows = {}; return { ...(await tokenExpiryJob(tx, rows)), rows }; };

  // ---- data: two companies, each with a licence and an employee
  const q = (sql: string, p: unknown[] = []) => admin.query(sql, p);
  await q("SELECT set_config('app.scope', 'system', false)");
  const company = async () => {
    const slug = 'tokens-' + randomUUID().slice(0, 8);
    const { rows: [co] } = await q(`INSERT INTO companies (name, slug, status, uninstall_token_hash, uninstall_token_ciphertext, notice_text)
      VALUES ($1, $1, 'active', $1, '\\x00', 'notice') RETURNING id`, [slug]);
    const { rows: [l] } = await q(`INSERT INTO licenses (company_id, key_hash, key_ciphertext, key_last4, plan, seat_limit, screenshot_tier)
      VALUES ($1, $2, '\\x00', 'abcd', 'growth', 10, 'standard') RETURNING id`, [co.id, randomUUID()]);
    const { rows: [e] } = await q("INSERT INTO employees (company_id, name, email) VALUES ($1, 'Ada', $2) RETURNING id", [co.id, slug + '@example.test']);
    return { id: co.id as string, lic: l.id as string, emp: e.id as string };
  };
  const A = await company(), B = await company();
  const token = async (co: { id: string; lic: string; emp: string }, expiresInMs: number, used: boolean) => {
    const hash = randomUUID();
    await q(`INSERT INTO enrollment_tokens (company_id, license_id, token_hash, employee_id, expires_at, used_at)
      VALUES ($1, $2, $3, $4, $5, $6)`, [co.id, co.lic, hash, co.emp, new Date(Date.now() + expiresInMs), used ? new Date() : null]);
    return hash;
  };
  const aExpired = await token(A, -HOUR, false);      // expired an hour ago, unused: deleted
  const bExpired = await token(B, -25 * HOUR, false); // other company, long expired: deleted
  const aUsedExpired = await token(A, -HOUR, true);   // used: kept (devices reference it)
  const aLive = await token(A, 23 * HOUR, false);     // unused, not expired: kept
  const exists = async (hash: string) => (await q('SELECT 1 FROM enrollment_tokens WHERE token_hash = $1', [hash])).rowCount === 1;

  // ---- a held lock: the run is skipped and deletes nothing
  const holder = new Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect();
  await holder.query("BEGIN; SELECT pg_advisory_xact_lock(hashtext('cron:token-expiry'))");
  const skipped = await run();
  assert.equal(skipped.skipped, true); assert.deepEqual(skipped.rows, {});
  assert.equal(await exists(aExpired), true, 'skipped run deletes nothing');
  await holder.query('ROLLBACK'); await holder.end();
  ok('lock held by another run → skipped, nothing deleted');

  // ---- a run: expired unused tokens of every company go; used and live ones stay
  const first = await run();
  assert.equal(first.skipped, false); assert.equal(first.more, false);
  assert.ok((first.rows.enrollment_tokens ?? 0) >= 2, 'both expired tokens counted');
  assert.equal(await exists(aExpired), false, 'expired unused token deleted');
  assert.equal(await exists(bExpired), false, 'other company’s expired token deleted in the same run');
  assert.equal(await exists(aUsedExpired), true, 'used token kept');
  assert.equal(await exists(aLive), true, 'unexpired token kept');
  ok('expired unused deleted across companies; used and unexpired kept');

  // ---- a deleted token is unknown to enroll's lookup (404 ENROLLMENT_TOKEN_INVALID)
  const { rows: auth } = await api.query('SELECT * FROM auth_enrollment_token($1)', [aExpired]);
  assert.equal(auth.length, 0, 'deleted token no longer found');
  ok('deleted token → not found by auth_enrollment_token');

  // ---- run twice = run once; nothing expired → 0
  const second = await run();
  assert.deepEqual(second.rows, {}, 'second run deletes nothing');
  assert.equal(await exists(aUsedExpired), true); assert.equal(await exists(aLive), true);
  ok('run twice = once; nothing to delete → rows_affected empty');

  await admin.end(); await api.end();
  console.log('all token-expiry checks passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
