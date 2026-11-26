// POST /cron/alert-digest, hourly: companies with alert_email.delivery 'hourly' or 'daily' get one email
// listing the tamper events received since their last digest (at most one interval back, so switching
// from instant never resends old events). Nothing new: no email, and the window still moves on.
// shortcut: a daily digest goes 24 h after the last one, not at a fixed local time; add that if asked.
import { alertLine, mailAlerts, recipients } from './mail';
import { add, JobTx, Rows } from './usage';

const MAX_LINES = 200;

export async function alertDigestJob(tx: JobTx, rows: Rows) {
  const r = await tx(async (c) => {
    // 5 min slack: the timer fires on the hour, so an hour since the last run may read 59:59.
    const { rows: due } = await c.query(
      `SELECT id, alert_email ->> 'delivery' AS delivery, alert_email -> 'types' AS types, slack_webhook_ciphertext AS slack, timezone,
              greatest(alert_digest_sent_at, now() - CASE alert_email ->> 'delivery' WHEN 'daily' THEN interval '24 hours' ELSE interval '1 hour' END) AS since
         FROM companies
        WHERE alert_email ->> 'delivery' IN ('hourly', 'daily')
          AND (alert_digest_sent_at IS NULL OR alert_digest_sent_at <= now() - CASE alert_email ->> 'delivery'
               WHEN 'daily' THEN interval '24 hours' ELSE interval '1 hour' END + interval '5 minutes')
        FOR UPDATE`, []);
    const sends: (() => void)[] = [];
    for (const co of due) {
      const { rows: ev } = await c.query(
        `SELECT t.hostname, t.event_type, t.occurred_at, e.name AS employee FROM tamper_events t
           LEFT JOIN devices d ON d.id = t.device_id LEFT JOIN employees e ON e.id = d.employee_id
          WHERE t.company_id = $1 AND t.received_at > $2 AND t.received_at <= now() AND $3::jsonb ? t.event_type
          ORDER BY t.occurred_at LIMIT $4`, [co.id, co.since, JSON.stringify(co.types), MAX_LINES + 1]);
      await c.query('UPDATE companies SET alert_digest_sent_at = now() WHERE id = $1', [co.id]);
      if (!ev.length) continue;
      const to = await recipients(c, co.id);
      const lines = ev.slice(0, MAX_LINES).map((t) => alertLine(t, co.timezone));
      if (ev.length > MAX_LINES) lines.push(`…and more. The full list is on the Alerts page.`);
      const n = ev.length > MAX_LINES ? `${MAX_LINES}+` : String(ev.length);
      lines.push('', `Times are in ${co.timezone}.`);
      sends.push(() => mailAlerts(to, `WorkBeat alert: ${n} tamper ${n === '1' ? 'event' : 'events'} in the last ${co.delivery === 'daily' ? 'day' : 'hour'}`,
        lines, co.slack));
      add(rows, 'digests', 1);
    }
    return sends;
  });
  for (const send of r?.value ?? []) send(); // after commit
  return { skipped: !r, more: false };
}
