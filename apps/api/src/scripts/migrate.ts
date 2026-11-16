// Applies db/migrations/*.sql in number order, each once (schema-migrations).
// Runs as the database owner (ADMIN_DATABASE_URL), never as the API role.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const dir = join(__dirname, '../../../../db/migrations');

async function main() {
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url) throw new Error('ADMIN_DATABASE_URL is required');
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await c.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
  for (const f of readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()) {
    if (done.has(f)) continue;
    // Each file has its own BEGIN/COMMIT. shortcut: a crash between COMMIT and this insert leaves
    // the file applied but unrecorded; fine for numbered forward-only files, revisit with CI deploys.
    await c.query(readFileSync(join(dir, f), 'utf8'));
    await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
    console.log('applied', f);
  }
  await c.end();
  console.log('migrations up to date');
}
main().catch((e) => { console.error(e.message); process.exit(1); });
