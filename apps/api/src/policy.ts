// The agent policy body and its ETag (serve-agent-policy/agent-policy, D8), shared by
// GET /v1/agents/policy and the policy stream (agent-policy-events) so both send the same bytes.
import { sha256, Tx } from './core';
import { cmpVersion, DeviceAuth, newestRelease, policyVersion } from './device';
import { Storage } from './storage';

export type Policy = { body: string; etag: string };

// Call inside the device's snapshot transaction, after authDevice.
export async function buildPolicy(c: Tx, dev: DeviceAuth, storage: Storage, base: string): Promise<Policy> {
  const { rows: [p] } = await c.query(
    `SELECT d.os, d.arch, d.agent_version, c.idle_threshold_seconds, c.min_agent_version, c.uninstall_token_hash,
            c.notice_text, c.notice_version, l.screenshot_tier, tier_interval(l.screenshot_tier) AS tier_min, s.activity, s.app_usage, s.window_titles,
            s.website_visits, s.screenshot_interval_seconds
       FROM devices d JOIN companies c ON c.id = d.company_id JOIN licenses l ON l.company_id = c.id
       JOIN employee_monitoring_settings s ON s.employee_id = d.employee_id
      WHERE d.id = $1`,
    [dev.device_id],
  );
  const [rules, sensitive, pauses] = await Promise.all([
    c.query('SELECT id, type, pattern, reason FROM block_rules WHERE company_id = app_company_id() ORDER BY created_at, id'),
    c.query( // the company's own sites and WorkBeat's for every company (A19); UNION de-duplicates
      `SELECT lower(pattern) AS pattern FROM sensitive_domains WHERE company_id = app_company_id()
       UNION SELECT lower(pattern) FROM platform_sensitive_domains ORDER BY 1`,
    ),
    c.query(
      `SELECT id AS pause_id, starts_at, ends_at FROM monitoring_pauses
        WHERE employee_id = $1 AND cancelled_at IS NULL AND ends_at > now() ORDER BY starts_at, id`,
      [dev.employee_id],
    ),
  ]);
  const rel = await newestRelease(c, p.os, p.arch);
  let minVersion: string | null = p.min_agent_version;
  if (rel && (!minVersion || cmpVersion(rel.min_supported, minVersion) > 0)) minVersion = rel.min_supported;
  // Re-signed once per UTC day so the ETag only moves daily for it (B16).
  const dayEnd = Math.floor(Date.now() / 86400_000) * 86400 + 2 * 86400;
  const update = rel && cmpVersion(rel.version, p.agent_version) > 0 ? rel : null;
  const data = {
    policy_version: await policyVersion(c, dev),
    block_rules: rules.rows,
    sensitive_domains: sensitive.rows.map((r) => r.pattern),
    // Never faster than the plan: a lowered tier slows a faster stored interval (B30); off stops screenshots.
    screenshot_interval_seconds: p.screenshot_tier === 'off' || !p.screenshot_interval_seconds ? 0 : Math.max(p.screenshot_interval_seconds, p.tier_min),
    idle_threshold_seconds: p.idle_threshold_seconds,
    min_agent_version: minVersion,
    update_package_url: update ? storage.sign(base, 'GET', 'agents', update.storage_path, dayEnd) : null,
    update_package_sha256: update?.sha256 ?? null,
    uninstall_token_hash: p.uninstall_token_hash,
    collection_notice: { text: p.notice_text, version: p.notice_version },
    monitoring_features: { activity: p.activity, app_usage: p.app_usage, window_titles: p.window_titles, website_visits: p.website_visits },
    monitoring_pauses: pauses.rows,
  };
  const body = JSON.stringify({ data });
  return { body, etag: `"${sha256(body).slice(0, 32)}"` };
}
