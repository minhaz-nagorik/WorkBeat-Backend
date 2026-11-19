import { randomBytes } from 'node:crypto';
// Agent contract: limits and zod schemas (docs/core/api/agent-contract.md).
// shortcut: lives in apps/api, not packages/shared; move it there when the web platform or the
// agents start importing it.
import { z } from 'zod';

export const LIMITS = {
  bodyBytes: 1024 * 1024,
  activityBodyBytes: 8 * 1024 * 1024,
  screenshotMaxBytes: 4 * 1024 * 1024,
  screenshotUploadUrlSeconds: 15 * 60,
  packageUrlSeconds: 60 * 60,
  enrollmentTokenHours: 24,
  tamperDetailBytes: 4096,
  windowPastMs: 8 * 24 * 3600 * 1000, // B7
  windowFutureMs: 24 * 3600 * 1000,
  releasedUploadDays: 7, // D45
  releasedUploadUntilHours: 24, // D38
  duplicateHeartbeatMinutes: 15, // D46
  // Per minute. Agents: heartbeat 1/5 min, policy 1/30 min, batch 1/10 min — far below.
  ratePerDeviceKey: 120,
  // Portal session (Bearer): a page loads many reports at once. 600 keeps one session under about
  // half of the 20 DB connections even at the 1 s report budget (17 Nov 2026).
  ratePerSession: 600,
  ratePerIpLicense: 20,
  ratePerIp: 120,
  // /cron/usage-summary stops starting new company days after this; the scheduler calls hourly (B28).
  usageSummaryBudgetMs: 50_000,
};

// Unix milliseconds (agent wire format) or an ISO string.
const time = z.union([z.number().int().nonnegative(), z.string().datetime({ offset: true })]).transform((v) => new Date(v));
const nonneg = z.number().int().nonnegative();
// A counter, or counts by type/reason (Mac sends dropped_records per record type).
const counter = z.union([nonneg, z.record(nonneg)]);
const os = z.enum(['macos', 'windows']);
const arch = z.enum(['x64', 'arm64']);

export const licenseValidateBody = z
  .object({ employee_id: z.string().uuid().optional(), os: os.optional(), arch: arch.optional() })
  .default({});

export const enrollBody = z.object({
  hostname: z.string().min(1).max(255),
  os,
  os_version: z.string().min(1).max(64),
  arch,
  model: z.string().max(128).nullish(),
  serial_number: z.string().max(128).nullish(),
  hardware_id: z.string().min(1).max(256),
  agent_version: z.string().min(1).max(32),
  enrolled_via: z.literal('manual').default('manual'),
  employee_id: z.string().uuid().optional(),
});

const helperState = z.enum(['running', 'restarting', 'not_running', 'no_session']);
const grant = z.enum(['granted', 'pending', 'denied', 'unreadable']);

export const heartbeatBody = z.object({
  agent_version: z.string().min(1).max(32),
  os_version: z.string().min(1).max(64).optional(),
  policy_version: nonneg.nullish(),
  outdated: z.boolean().optional(),
  helper_status: z.union([helperState, z.record(helperState)]).nullish(), // Windows: string, Mac: per session
  browser_access: z.record(grant).nullish(),
  permissions: z.union([z.literal('not_required'), z.record(grant)]).nullish(),
  store_bytes: nonneg.optional(),
  oldest_unsent_at: time.nullish(),
  dropped_records: counter.optional(),
  dropped_samples: counter.optional(),
  screenshot_skips: counter.optional(),
  quarantined_batches: nonneg.optional(),
  blocking_status: z.string().max(32).nullish(),
  helper_restarts_24h: nonneg.optional(),
  upload_failures_24h: nonneg.optional(),
  update_failure: z.string().max(256).nullish(),
  active_pause_id: z.string().uuid().nullish(),
  notice_version: z.number().int().positive().nullish(),
  notice_acknowledged_at: time.nullish(),
  uptime_seconds: nonneg.optional(),
});
export const HEALTH_FIELDS = [
  'store_bytes', 'oldest_unsent_at', 'dropped_records', 'dropped_samples', 'screenshot_skips',
  'quarantined_batches', 'blocking_status', 'helper_restarts_24h', 'upload_failures_24h',
  'update_failure', 'uptime_seconds',
] as const;

const sessionUser = z.string().max(256);
const appSession = z
  .object({
    session_user: sessionUser,
    bundle_id: z.string().max(512),
    app_name: z.string().max(512),
    process_name: z.string().max(512).default(''),
    window_title: z.string().max(4096).default(''),
    started_at: time,
    ended_at: time,
    duration_seconds: nonneg,
    clock_flag: z.boolean().default(false),
    clock_suspect: z.boolean().optional(), // agent spec's name for clock_flag
  })
  .refine((s) => s.ended_at >= s.started_at, { message: 'ended_at before started_at', path: ['ended_at'] });
const urlVisit = z.object({
  session_user: sessionUser,
  browser: z.string().min(1).max(128),
  url: z.string().min(1).max(8192),
  domain: z.string().min(1).max(253),
  visited_at: time,
  duration_seconds: nonneg,
});
const bucket = z
  .object({ bucket_start: time, active_samples: nonneg, total_samples: nonneg })
  .refine((b) => b.active_samples <= b.total_samples, { message: 'active_samples > total_samples', path: ['active_samples'] });
const idle = z
  .object({ session_user: sessionUser, started_at: time, ended_at: time })
  .refine((s) => s.ended_at >= s.started_at, { message: 'ended_at before started_at', path: ['ended_at'] });

export const activityBody = z.object({
  batch_id: z.string().uuid(),
  app_sessions: z.array(appSession).default([]),
  url_visits: z.array(urlVisit).default([]),
  activity_buckets: z.array(bucket).default([]),
  idle_intervals: z.array(idle).default([]),
});

export const screenshotBody = z.object({
  id: z.string().uuid(),
  captured_at: time,
  bytes: z.number().int().positive(),
});

export const tamperBody = z.object({
  id: z.string().uuid(),
  // offline and duplicate_device_id are backend-only (D46) → enum failure → 422.
  event_type: z.enum(['process_restart', 'hosts_modified', 'config_changed', 'clock_tampered', 'permission_revoked']),
  detail: z
    .unknown()
    .refine((d) => typeof d === 'object' && d !== null && !Array.isArray(d), 'detail must be an object')
    .refine((d) => Buffer.byteLength(JSON.stringify(d) ?? '') <= LIMITS.tamperDetailBytes, 'detail too large')
    .default({}),
  occurred_at: time,
  repeat_count: z.number().int().min(1).default(1),
});

export const uuid = z.string().uuid();

// Licence key as stored and hashed: WB-XXXX-XXXX-XXXX-XXXX, upper case (license-key spec).
export const normaliseLicenceKey = (k: string) => k.trim().toUpperCase();

// WB-XXXX-XXXX-XXXX-XXXX from an unambiguous alphabet (no 0/O, 1/I/L): 16 × 5 bits = 80 bits.
const KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newLicenceKey() {
  const chars = [...randomBytes(16)].map((b) => KEY_ALPHABET[b % KEY_ALPHABET.length]).join('');
  return 'WB-' + chars.match(/.{4}/g)!.join('-');
}

// A new company's monitoring notice until its admin edits it.
export const DEFAULT_NOTICE =
  'This computer is monitored by your employer with WorkBeat: apps and websites used, active time and, if enabled, screenshots.';

// Temporary password: 16 readable characters in 4 groups (no 0/O, 1/l/I/i), about 89 bits.
const PW_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
export function temporaryPassword() {
  const chars = [...randomBytes(16)].map((b) => PW_ALPHABET[b % PW_ALPHABET.length]).join('');
  return chars.match(/.{4}/g)!.join('-');
}
