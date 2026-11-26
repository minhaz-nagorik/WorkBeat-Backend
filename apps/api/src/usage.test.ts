// sessionHours: a session is split across the clock hours it covers (usage-reports "A session spans several hours").
// Runs against a temporary app_sessions table (it shadows the real one), so it needs a database but writes nothing.
// Usage: node --env-file=.env --test dist/usage.test.js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from 'pg';
import { sessionHours } from './usage';

const url = process.env.DATABASE_URL;

test('sessionHours splits a session across hours and keeps its total', { skip: !url && 'DATABASE_URL not set' }, async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL timezone = 'Asia/Dhaka'");
    await c.query(`CREATE TEMP TABLE app_sessions (employee_id uuid, app_name text, started_at timestamptz, ended_at timestamptz, duration_seconds int) ON COMMIT DROP`);
    await c.query(`INSERT INTO app_sessions VALUES
      (gen_random_uuid(), 'spec', '2026-10-05 12:30+06', '2026-10-05 15:15+06', 9900),
      (gen_random_uuid(), 'odd',  '2026-10-05 16:10:00.3+06', '2026-10-05 18:00:00.9+06', 6600),
      (gen_random_uuid(), 'zero', '2026-10-05 19:00+06', '2026-10-05 19:00+06', 0),
      (gen_random_uuid(), 'same', '2026-10-05 20:05+06', '2026-10-05 20:50+06', 2700)`);
    const hours = async (app: string) => (await c.query(
      `SELECT hour, sec::int AS sec, first FROM (${sessionHours('app_name = $1')}) x ORDER BY hour`, [app])).rows;
    const spec = await hours('spec');
    assert.deepEqual(spec.map((r) => [r.hour, r.sec]), [[12, 1800], [13, 3600], [14, 3600], [15, 900]]);
    assert.deepEqual(spec.map((r) => r.first), [true, false, false, false], 'only the start hour counts the session');
    const odd = await hours('odd');
    assert.deepEqual(odd.map((r) => r.hour), [16, 17, 18]);
    assert.equal(odd.reduce((a, r) => a + r.sec, 0), 6600, 'pieces sum to duration_seconds');
    assert.deepEqual((await hours('zero')).map((r) => [r.hour, r.sec, r.first]), [[19, 0, true]]);
    assert.deepEqual((await hours('same')).map((r) => [r.hour, r.sec]), [[20, 2700]]);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});
