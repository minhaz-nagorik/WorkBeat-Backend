// Outgoing email through Resend. Without RESEND_API_KEY (local dev, smoke tests) messages are
// written to STORAGE_DIR/outbox instead, never to the log (they carry invitation links).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, decrypt } from './core';

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

type Q = { query: (q: string, v: unknown[]) => Promise<{ rows: any[] }> };
// Who gets a company's alert emails: enabled users whose role is in alert_email.roles. $1 is the company id.
const RECIPIENTS = `SELECT u.email FROM users u JOIN companies co ON co.id = u.company_id
  WHERE u.company_id = $1 AND u.disabled_at IS NULL
    AND co.alert_email -> 'roles' ? CASE WHEN u.role = 'company_admin' THEN 'company_admin' ELSE u.role_id::text END`;
export const recipients = async (c: Q, companyId: string) => (await c.query(RECIPIENTS, [companyId])).rows.map((r) => r.email as string);
// Same words as the admin labels map (WorkBeat-Admin src/lib/labels.ts, A4).
const EVENT_LABEL: Record<string, string> = {
  hosts_modified: 'Website blocking changed', offline: 'Computer offline', process_restart: 'WorkBeat was closed',
  permission_revoked: 'Permission turned off', clock_tampered: 'Computer clock changed',
  config_changed: 'WorkBeat settings edited', duplicate_device_id: 'Possible duplicate computer',
};
export const alertLabel = (type: string) => EVENT_LABEL[type] ?? type.replace(/_/g, ' ');
// "26 Nov 2026, 1:13 PM" in the company's time zone.
export const alertTime = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
    .format(new Date(d)).replace(/\b(am|pm)\b/, (m) => m.toUpperCase());
export const alertLine = (t: { event_type: string; hostname: string | null; employee: string | null; occurred_at: Date }, timeZone: string) =>
  `• ${alertLabel(t.event_type)} on ${t.hostname ?? 'a computer'}${t.employee ? ` (${t.employee})` : ''}, ${alertTime(t.occurred_at, timeZone)}`;
// Slack reads <…> as links and mentions (<!channel>); host names come from the agent, so escape them.
const slackEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Sends title (email subject) and lines to the recipients, and to the company's Slack webhook
// (slack-alerts) when it has one. Never logs the URL.
export const mailAlerts = (to: string[], title: string, lines: string[], slack?: Buffer | null) => {
  const url = `${config().PORTAL_URL}/alerts`;
  for (const email of to)
    void sendMail(email, title, `${lines.join('\n')}\n\nOpen the Alerts page: ${url}`)
      .catch(() => console.error(JSON.stringify({ t: new Date(), level: 'error', err: 'tamper_email_failed' })));
  if (slack) void postSlack(slack, `*${slackEscape(title)}*\n${lines.map(slackEscape).join('\n')}\n<${url}|Open Alerts page>`)
    .catch(() => console.error(JSON.stringify({ t: new Date(), level: 'error', err: 'tamper_slack_failed' })));
};
async function postSlack(blob: Buffer, text: string) {
  const r = await fetch(decrypt(blob, config().SECRETS_ENCRYPTION_KEY), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }), signal: AbortSignal.timeout(10_000), redirect: 'error',
  });
  if (!r.ok) throw new Error(`slack ${r.status}`);
}

// Instant alert email for one tamper event, if the company has instant delivery and the type on.
// Query inside the tenant transaction; call the returned send after commit. Hourly/daily: alert-digest.ts.
export async function tamperAlert(c: Q, eventId: string) {
  const { rows: [t] } = await c.query(
    `SELECT t.company_id, t.hostname, t.event_type, t.occurred_at, co.timezone, co.slack_webhook_ciphertext AS slack, e.name AS employee
       FROM tamper_events t JOIN companies co ON co.id = t.company_id
       LEFT JOIN devices d ON d.id = t.device_id LEFT JOIN employees e ON e.id = d.employee_id
      WHERE t.id = $1 AND co.alert_email ->> 'delivery' = 'instant' AND co.alert_email -> 'types' ? t.event_type`, [eventId]);
  if (!t) return () => {};
  const to = await recipients(c, t.company_id);
  return () => mailAlerts(to, 'WorkBeat alert: Tamper detected', [
    `Event: ${alertLabel(t.event_type)}`, `Employee: ${t.employee ?? 'Unknown'}`, `Computer: ${t.hostname ?? 'Unknown'}`, `Time: ${alertTime(t.occurred_at, t.timezone)} (${t.timezone})`,
  ], t.slack);
}
