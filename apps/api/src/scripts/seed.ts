// Creates a test company with a licence and employees, and prints the licence key once.
// Stand-in for company signup (provision-companies) until the portal exists.
// Usage: pnpm seed -- --name "Acme" --slug acme --seats 10 --tier standard --employees "Ada Lovelace,Alan Turing" --admin-email you@acme.com
// An existing --slug only gets the admin added.
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { hashPassword } from '../auth';
import { normaliseLicenceKey } from '../contract';
import { encrypt, sha256, token } from '../core';

const DEFAULT_NOTICE =
  'This computer is monitored by your employer with WorkBeat: apps and websites used, active time and, if enabled, screenshots.';
const DEFAULT_SENSITIVE = ['chase.com', 'paypal.com', 'mail.google.com', 'outlook.live.com', 'mychart.com'];

// WB-XXXX-XXXX-XXXX-XXXX from an unambiguous alphabet (no 0/O, 1/I/L): 16 × 5 bits = 80 bits.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newLicenceKey() {
  const chars = [...randomBytes(16)].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return 'WB-' + chars.match(/.{4}/g)!.join('-');
}

async function main() {
  const { values: a } = parseArgs({
    options: {
      name: { type: 'string', default: 'Acme Test' },
      slug: { type: 'string', default: 'acme-test' },
      plan: { type: 'string', default: 'growth' },
      seats: { type: 'string', default: '10' },
      tier: { type: 'string', default: 'standard' },
      employees: { type: 'string', default: 'Ada Lovelace,Alan Turing,Grace Hopper' },
      'admin-email': { type: 'string', default: 'admin@example.test' },
      'admin-name': { type: 'string', default: 'Company Admin' },
      'rotate-key': { type: 'boolean', default: false },
      'staff-email': { type: 'string' }, // create a super_admin (no company); MFA is set up at first sign-in
    },
  });
  const url = process.env.ADMIN_DATABASE_URL, secret = process.env.SECRETS_ENCRYPTION_KEY;
  if (!url || !secret) throw new Error('ADMIN_DATABASE_URL and SECRETS_ENCRYPTION_KEY are required');

  const licenceKey = newLicenceKey();
  const uninstall = token('wbu_');
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    const adminPassword = randomBytes(12).toString('base64url');
    const addAdmin = async (companyId: string) =>
      c.query("INSERT INTO users (email, name, role, company_id, password_hash) VALUES ($1, $2, 'company_admin', $3, $4)",
        [a['admin-email']!.toLowerCase(), a['admin-name'], companyId, await hashPassword(adminPassword)]);
    const existing = (await c.query('SELECT id FROM companies WHERE slug = $1', [a.slug])).rows[0];
    if (a['staff-email']) { // operator script: the only way to create the first super_admin (staff-accounts)
      await c.query("INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, 'super_admin', $3)",
        [a['staff-email'].toLowerCase(), a['admin-name'], await hashPassword(adminPassword)]);
      await c.query('COMMIT');
      console.log(`staff ${a['staff-email']} created; password (shown once): ${adminPassword}`);
      return;
    }
    if (existing && a['rotate-key']) { // new licence key; the old one and its unused tokens stop working
      await c.query('UPDATE licenses SET key_hash = $2, key_ciphertext = $3, key_last4 = $4, key_reset_at = now() WHERE company_id = $1',
        [existing.id, sha256(normaliseLicenceKey(licenceKey)), encrypt(licenceKey, secret), licenceKey.slice(-4)]);
      await c.query('DELETE FROM enrollment_tokens WHERE company_id = $1 AND used_at IS NULL', [existing.id]);
      await c.query('COMMIT');
      console.log(`${a.slug}: new licence key (shown once): ${licenceKey}`);
      return;
    }
    if (existing) { // existing company: only add the admin
      await addAdmin(existing.id);
      await c.query('COMMIT');
      console.log(`admin ${a['admin-email']} added to ${a.slug}; password (shown once): ${adminPassword}`);
      return;
    }
    const { rows: [co] } = await c.query(
      `INSERT INTO companies (name, slug, status, uninstall_token_hash, uninstall_token_ciphertext, notice_text)
       VALUES ($1, $2, 'trial', $3, $4, $5) RETURNING id`,
      [a.name, a.slug, sha256(uninstall), encrypt(uninstall, secret), DEFAULT_NOTICE],
    );
    await c.query(
      `INSERT INTO licenses (company_id, key_hash, key_ciphertext, key_last4, plan, seat_limit, screenshot_tier, trial_ends_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '14 days')`,
      [co.id, sha256(normaliseLicenceKey(licenceKey)), encrypt(licenceKey, secret), licenceKey.slice(-4), a.plan, a.plan === 'enterprise' ? null : Number(a.seats), a.tier],
    );
    for (const p of DEFAULT_SENSITIVE)
      await c.query('INSERT INTO sensitive_domains (company_id, pattern, is_default) VALUES ($1, $2, true)', [co.id, p]);
    const names = a.employees!.split(',').map((n) => n.trim()).filter(Boolean);
    for (const n of names)
      await c.query('INSERT INTO employees (company_id, name, email) VALUES ($1, $2, $3)',
        [co.id, n, n.toLowerCase().replace(/[^a-z]+/g, '.') + '@example.test']);
    await addAdmin(co.id);
    await c.query('COMMIT');
    console.log(`admin     ${a['admin-email']}, password (shown once): ${adminPassword}`);
    console.log(`company   ${a.name} (${co.id})`);
    console.log(`employees ${names.length}, seats ${a.plan === 'enterprise' ? 'unlimited' : a.seats}, tier ${a.tier}`);
    console.log(`licence key (shown once): ${licenceKey}`);
    console.log(`uninstall token (shown once): ${uninstall}`);
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
