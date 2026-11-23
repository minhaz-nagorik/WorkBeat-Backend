// Outgoing email through Resend. Without RESEND_API_KEY (local dev, smoke tests) messages are
// written to STORAGE_DIR/outbox instead, never to the log (they carry invitation links).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './core';

export async function sendMail(to: string, subject: string, text: string) {
  const cfg = config();
  if (cfg.RESEND_API_KEY) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: cfg.EMAIL_FROM, to: [to], subject, text }),
      signal: AbortSignal.timeout(10_000), // callers await this inside their transaction
    });
    if (!r.ok) throw new Error(`resend ${r.status}`);
    return;
  }
  const dir = join(cfg.STORAGE_DIR, 'outbox');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${Date.now()}-${to.replace(/[^\w.@-]/g, '_')}.json`), JSON.stringify({ to, subject, text }, null, 2));
}
