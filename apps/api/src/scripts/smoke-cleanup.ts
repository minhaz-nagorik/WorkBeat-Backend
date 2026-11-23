// Checks /cron/cleanup (data-retention) against a real database: runs cleanupJob as the API role in
// system scope, the way cron.controller does. Writes and deletes data, so it refuses any database
// whose name does not end in _test.
// Usage: ADMIN_DATABASE_URL=…/x_test DATABASE_URL=…/x_test pnpm smoke:cleanup
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { cleanupJob } from '../cleanup';
import { LIMITS } from '../contract';
import type { Tx } from '../core';
import type { JobTx, Rows } from '../usage';

const DAY = 24 * 3600 * 1000;
const ago = (days: number, extraMs = 0) => new Date(Date.now() - days * DAY + extraMs);
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
      const { rows: [l] } = await c.query("SELECT pg_try_advisory_xact_lock(hashtext('cron:cleanup')) AS ok");
      const r = l.ok ? { value: await work(c) } : null;
      await c.query('COMMIT');
      return r;
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  };
  // Fake R2: objects that exist, paths whose delete fails, and a switch for Storage being down.
  const objects = new Set<string>(), broken = new Set<string>();
  let down = false;
  const remove = async (path: string) => { if (down || broken.has(path)) throw new Error('R2 DELETE 500'); objects.delete(path); };
  const run = async () => { const rows: Rows = {}; return { ...(await cleanupJob(tx, rows, remove)), rows }; };
  const runAll = async () => { const total: Rows = {}; let r;
    do { r = await run(); for (const [k, v] of Object.entries(r.rows)) total[k] = (total[k] ?? 0) + v; } while (r.more);
    return total; };

  // Clear whatever earlier runs or seeds left in this _test database, so totals count only this test's rows.
  await runAll();

  // ---- data: company A keeps 30 days, B keeps 90 (B has a released device)
  const q = (sql: string, p: unknown[] = []) => admin.query(sql, p);
  await q("SELECT set_config('app.scope', 'system', false)");
  // Older months than the migrations create, with bounds made exactly as ensure_month_partitions makes them.
  await q(`DO $$ DECLARE t text; m date; BEGIN
    FOREACH t IN ARRAY ARRAY['app_sessions', 'url_visits', 'activity_buckets', 'idle_intervals'] LOOP
      FOR i IN -6..-2 LOOP
        m := (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => i))::date;
        IF to_regclass(format('%s_%s', t, to_char(m, 'YYYYMM'))) IS NULL THEN
          EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                         format('%s_%s', t, to_char(m, 'YYYYMM')), t, m::timestamptz, (m + interval '1 month')::timestamptz);
        END IF;
      END LOOP;
    END LOOP; END $$`);
  const company = async (days: number) => {
    const slug = 'cleanup-' + randomUUID().slice(0, 8);
    const { rows: [co] } = await q(`INSERT INTO companies (name, slug, status, uninstall_token_hash, uninstall_token_ciphertext, notice_text, data_retention_days)
      VALUES ($1, $1, 'active', $1, '\\x00', 'notice', $2) RETURNING id`, [slug, days]);
    await q(`INSERT INTO licenses (company_id, key_hash, key_ciphertext, key_last4, plan, seat_limit, screenshot_tier)
      VALUES ($1, $2, '\\x00', 'abcd', 'growth', 10, 'standard')`, [co.id, randomUUID()]);
    const { rows: [e] } = await q("INSERT INTO employees (company_id, name, email) VALUES ($1, 'Ada', $2) RETURNING id", [co.id, slug + '@example.test']);
    const device = async () => (await q(`INSERT INTO devices (company_id, employee_id, hostname, os, os_version, arch, hardware_id, agent_version)
      VALUES ($1, $2, 'h', 'macos', '14', 'arm64', $3, '1.0') RETURNING id`, [co.id, e.id, randomUUID()])).rows[0].id as string;
    return { id: co.id as string, emp: e.id as string, device };
  };
  const A = await company(30), B = await company(90);
  const aDev = await A.device(), bDev = await B.device(), bReleased = await B.device();
  await q('UPDATE devices SET released_at = $2 WHERE id = $1', [bReleased, ago(10)]);

  const activity = async (co: { id: string; emp: string }, dev: string, at: Date) => {
    const p = [co.id, dev, co.emp, randomUUID(), at];
    await q(`INSERT INTO app_sessions (company_id, device_id, employee_id, batch_id, os_user, bundle_id, app_name, process_name, started_at, ended_at, duration_seconds)
      VALUES ($1, $2, $3, $4, 'ada', 'b', 'App', 'p', $5, $5::timestamptz + interval '1 minute', 60)`, p);
    await q(`INSERT INTO url_visits (company_id, device_id, employee_id, batch_id, os_user, browser, url, domain, visited_at, duration_seconds)
      VALUES ($1, $2, $3, $4, 'ada', 'safari', 'https://x.test/', 'x.test', $5, 60)`, p);
    await q(`INSERT INTO activity_buckets (company_id, device_id, employee_id, bucket_start, active_samples, total_samples)
      VALUES ($1, $2, $3, $4, 1, 2)`, [co.id, dev, co.emp, at]);
    await q(`INSERT INTO idle_intervals (company_id, device_id, employee_id, batch_id, os_user, started_at, ended_at)
      VALUES ($1, $2, $3, $4, 'ada', $5, $5::timestamptz + interval '1 minute')`, p);
  };
  await activity(A, aDev, ago(45));                 // past 30 days: deleted
  await activity(A, aDev, ago(30, -60_000));        // 30 days and a minute: deleted
  await activity(A, aDev, ago(30, 60_000));         // a minute inside 30 days: kept
  await activity(A, aDev, ago(29));                 // kept
  await activity(B, bDev, ago(45));                 // B keeps 90: kept
  await activity(B, bDev, ago(95));                 // deleted
  await activity(B, bReleased, ago(95));            // released device follows retention: deleted
  await activity(B, bReleased, ago(60));            // kept

  const tamper = async (co: string, dev: string, at: Date, resolved: boolean) =>
    (await q(`INSERT INTO tamper_events (id, company_id, device_id, hostname, event_type, occurred_at, resolved_at)
      VALUES ($1, $2, $3, 'h', 'offline', $4, $5) RETURNING id`, [randomUUID(), co, dev, at, resolved ? at : null])).rows[0].id as string;
  const tResolvedOld = await tamper(A.id, aDev, ago(45), true);
  const tOpenOld = await tamper(A.id, aDev, ago(45), false);
  const tResolvedB = await tamper(B.id, bDev, ago(45), true);
  const batch = async (at: Date) => (await q(`INSERT INTO ingest_batches (device_id, batch_id, company_id, received_at, counts, body_sha256)
      VALUES ($1, $2, $3, $4, '{}', 'x') RETURNING batch_id`, [aDev, randomUUID(), A.id, at])).rows[0].batch_id as string;
  const ibOld = await batch(ago(15)), ibNew = await batch(ago(13));
  const shot = async (co: { id: string; emp: string }, dev: string, captured: Date, o: { pending?: Date; thumb?: boolean; missing?: boolean; broken?: boolean } = {}) => {
    const id = randomUUID(), path = `${co.id}/${dev}/${id}.jpg`;
    await q(`INSERT INTO screenshots (id, company_id, device_id, employee_id, captured_at, storage_path, bytes, thumb_bytes, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, 10, $7, $8, $9)`,
      [id, co.id, dev, co.emp, captured, path, o.thumb ? 5 : null, o.pending ? 'pending' : 'uploaded', o.pending ?? captured]);
    if (!o.missing) { objects.add(path); if (o.thumb) objects.add(path.replace(/\.jpg$/, '.thumb.jpg')); }
    if (o.broken) broken.add(path);
    return { id, path };
  };
  const sOld = await shot(A, aDev, ago(45), { thumb: true });         // past 30 days: file, thumbnail and row go
  const sNew = await shot(A, aDev, ago(29));                          // kept
  const sMissing = await shot(A, aDev, ago(45), { missing: true });   // file already gone: row goes, counted
  const sBroken = await shot(A, aDev, ago(45), { broken: true });     // Storage refuses: row kept for next run
  const sB = await shot(B, bDev, ago(45));                            // B keeps 90: kept
  const sStale = await shot(B, bDev, ago(0, -3600_000), { pending: ago(0, -25 * 3600_000) }); // pending 25 h: goes
  const sFresh = await shot(B, bDev, ago(0, -3600_000), { pending: ago(0, -23 * 3600_000) }); // pending 23 h: kept
  await q(`INSERT INTO notice_acknowledgements (company_id, device_id, employee_id, notice_version, acknowledged_at)
    VALUES ($1, $2, $3, 1, $4)`, [A.id, aDev, A.emp, ago(400)]);

  const count = async (t: string, co: string, where = 'true') =>
    Number((await q(`SELECT count(*) AS n FROM ${t} WHERE company_id = $1 AND ${where}`, [co])).rows[0].n);
  const TABLES = [['app_sessions', 'started_at'], ['url_visits', 'visited_at'], ['activity_buckets', 'bucket_start'], ['idle_intervals', 'started_at']];

  // ---- a held lock: the run is skipped and deletes nothing
  const holder = new Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect();
  await holder.query("BEGIN; SELECT pg_advisory_xact_lock(hashtext('cron:cleanup'))");
  const skipped = await run();
  assert.equal(skipped.skipped, true); assert.deepEqual(skipped.rows, {});
  await holder.query('ROLLBACK'); await holder.end();
  ok('lock held by another run → skipped, nothing deleted');

  // ---- budget: a zero budget stops after the first batch with more: true; later runs finish
  const budget = LIMITS.cleanupBudgetMs;
  LIMITS.cleanupBudgetMs = 0;
  const cut = await run();
  assert.equal(cut.more, true); assert.equal(cut.skipped, false);
  // Old partitions go first: even a run that stops on its budget has dropped them.
  assert.ok((cut.rows.partitions_dropped ?? 0) >= 4, 'a run cut short still drops old partitions');
  LIMITS.cleanupBudgetMs = budget;
  ok('budget spent → more: true, old partitions already dropped');

  const total = await runAll();
  for (const [t, col] of TABLES) {
    assert.equal(await count(t, A.id), 2, `${t}: A keeps its last 30 days only`);
    assert.equal(await count(t, A.id, `${col} < now() - interval '30 days'`), 0, `${t}: nothing in A past 30 days`);
    assert.equal(await count(t, B.id), 2, `${t}: B keeps 45 days old on both devices`);
    assert.equal(await count(t, B.id, `device_id = '${bReleased}'`), 1, `${t}: released device follows retention`);
  }
  ok('activity: each company keeps its own window; released device follows retention; boundary ±1 min');

  const has = async (sql: string, p: unknown[]) => (await q(sql, p)).rowCount === 1;
  assert.equal(await has('SELECT 1 FROM tamper_events WHERE id = $1', [tResolvedOld]), false, 'resolved old event deleted');
  assert.equal(await has('SELECT 1 FROM tamper_events WHERE id = $1', [tOpenOld]), true, 'open event kept');
  assert.equal(await has('SELECT 1 FROM tamper_events WHERE id = $1', [tResolvedB]), true, 'B event inside 90 days kept');
  assert.equal(await has('SELECT 1 FROM ingest_batches WHERE batch_id = $1', [ibOld]), false, 'ingest batch 15 days old deleted');
  assert.equal(await has('SELECT 1 FROM ingest_batches WHERE batch_id = $1', [ibNew]), true, 'ingest batch 13 days old kept');
  assert.equal(await count('notice_acknowledgements', A.id), 1, 'notice acknowledgement kept');
  ok('tamper events, ingest_batches, notice acknowledgements kept');

  const shotRow = (id: string) => has('SELECT 1 FROM screenshots WHERE id = $1', [id]);
  assert.equal(total.screenshots, 3, 'three screenshot rows deleted');
  assert.equal(total.screenshot_delete_failed, 1, 'one failed delete counted');
  assert.equal(await shotRow(sOld.id), false); assert.equal(objects.has(sOld.path), false, 'file deleted');
  assert.equal(objects.has(sOld.path.replace(/\.jpg$/, '.thumb.jpg')), false, 'thumbnail deleted');
  assert.equal(await shotRow(sMissing.id), false, 'already-missing file counts as deleted');
  assert.equal(await shotRow(sBroken.id), true, 'refused delete keeps the row'); assert.ok(objects.has(sBroken.path));
  assert.equal(await shotRow(sNew.id), true, 'inside retention kept'); assert.ok(objects.has(sNew.path));
  assert.equal(await shotRow(sB.id), true, 'B keeps 90 days');
  assert.equal(await shotRow(sStale.id), false, 'pending 25 h deleted');
  assert.equal(await shotRow(sFresh.id), true, 'pending 23 h kept');
  broken.clear();
  assert.deepEqual(await runAll(), { screenshots: 1 }, 'the refused one goes on the next run');
  assert.equal(objects.has(sBroken.path), false);
  ok('screenshots: file and thumbnail before row; missing file counted; refused kept then retried; pending > 24 h');

  const parts = (await q(`SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS b FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'app_sessions'`)).rows;
  const ends = parts.map((r) => new Date(/TO \('([^']+)'\)/.exec(r.b)![1]));
  assert.ok(ends.every((e) => e >= ago(90)), 'no partition ending more than 90 days ago is left');
  assert.ok(ends.some((e) => e < ago(60)), 'a partition partly inside 90 days is kept');
  const { rows: [ahead] } = await q(`SELECT to_regclass('app_sessions_' || to_char(now() + interval '2 months', 'YYYYMM')) IS NOT NULL AS ok`);
  assert.ok(ahead.ok, 'partitions exist two months ahead');
  ok('partitions: created ahead, dropped past 90 days, partly-inside month kept');

  // ---- 30 → 90: nothing more goes; 90 → 30: B's backlog goes
  const again = await runAll();
  assert.deepEqual(again, {}, 'a second run deletes nothing');
  await q('UPDATE companies SET data_retention_days = 90 WHERE id = $1', [A.id]);
  assert.deepEqual(await runAll(), {}, 'raising retention deletes nothing');
  await q('UPDATE companies SET data_retention_days = 30 WHERE id = $1', [B.id]);
  const lowered = await runAll();
  assert.equal(lowered.app_sessions, 2, 'lowering retention deletes the backlog');
  for (const [t, col] of TABLES) assert.equal(await count(t, B.id), 0, `${t}: B now keeps 30 days`);
  ok('run twice = once; 30 → 90 deletes nothing; 90 → 30 clears the backlog');

  // ---- Storage down: activity is still cleaned, no screenshot row goes, and the sweep stops after
  // a batch's worth of failures in a row with more: false (the scheduler would only repeat them).
  const downShots = [await shot(B, bDev, ago(45)), await shot(B, bDev, ago(45)), await shot(B, bDev, ago(45))];
  await activity(B, bDev, ago(45));
  const batchSize = LIMITS.cleanupScreenshotBatch;
  LIMITS.cleanupScreenshotBatch = 2; down = true;
  const out = await run();
  assert.equal(out.more, false, 'Storage down does not ask to be called again');
  assert.equal(out.rows.app_sessions, 1, 'activity still cleaned');
  assert.equal(out.rows.screenshots, undefined, 'no screenshot row deleted');
  assert.equal(out.rows.screenshot_delete_failed, 2, 'stops after a batch of failures in a row');
  for (const d of downShots) assert.equal(await shotRow(d.id), true);
  LIMITS.cleanupScreenshotBatch = batchSize; down = false;
  assert.equal((await runAll()).screenshots, 3, 'all go once Storage is back');
  ok('Storage down: activity cleaned, rows kept, sweep stops with more: false, recovers next run');

  await admin.end(); await api.end();
  console.log('all cleanup checks passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
