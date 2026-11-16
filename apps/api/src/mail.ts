// Outgoing email through Resend, or SMTP until Resend is set up. With neither (local dev) messages
// are written to STORAGE_DIR/outbox instead, never to the log (they carry invitation links).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTransport, type Transporter } from 'nodemailer';
import { config } from './core';

let smtp: Transporter | undefined;

export async function sendMail(to: string, subject: string, text: string) {
  const cfg = config();
  if (cfg.RESEND_API_KEY) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: cfg.EMAIL_FROM, to: [to], subject, text }),
    });
    if (!r.ok) throw new Error(`resend ${r.status}`);
    return;
  }
  if (cfg.SMTP_USER && cfg.SMTP_PASS) {
    smtp ??= createTransport({
      host: cfg.SMTP_HOST, port: cfg.SMTP_PORT, secure: cfg.SMTP_PORT === 465,
      auth: { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS },
    });
    await smtp.sendMail({ from: cfg.EMAIL_FROM, to, subject, text });
    return;
  }
  const dir = join(cfg.STORAGE_DIR, 'outbox');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${Date.now()}-${to.replace(/[^\w.@-]/g, '_')}.json`), JSON.stringify({ to, subject, text }, null, 2));
}
