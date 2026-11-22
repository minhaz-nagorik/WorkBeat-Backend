// Device-key guard (enroll-devices/device-authentication) and policy resolution shared by
// heartbeat and policy (serve-agent-policy/agent-policy).
import { LIMITS } from './contract';
import { ApiError, sha256, Tx } from './core';

export type DeviceAuth = { device_id: string; company_id: string; employee_id: string; released: boolean };
export type RouteKind = 'normal' | 'upload' | 'deactivate';

// Throws 401s. Returns the 402 the route must answer (heartbeat still writes before answering it).
export async function authDevice(c: Tx, key: string | undefined, kind: RouteKind): Promise<{ dev: DeviceAuth; billing: ApiError | null }> {
  if (!key) throw new ApiError(401, 'DEVICE_REVOKED', 'Device key not accepted');
  return authDeviceHash(c, sha256(key), kind);
}

// The same check from the key's hash: the policy stream re-checks access on every push without
// keeping the key (agent-policy-events).
export async function authDeviceHash(c: Tx, keyHash: string, kind: RouteKind): Promise<{ dev: DeviceAuth; billing: ApiError | null }> {
  const { rows } = await c.query('SELECT * FROM auth_device($1)', [keyHash]);
  if (!rows[0]) throw new ApiError(401, 'DEVICE_REVOKED', 'Device key not accepted');
  const d = rows[0];
  if (d.released) {
    const uploadWindow = d.released_at.getTime() + LIMITS.releasedUploadDays * 86400_000;
    if (!(kind === 'upload' && Date.now() < uploadWindow)) {
      throw new ApiError(401, 'DEVICE_RELEASED', 'Device released', {
        released_at: d.released_at,
        upload_until: new Date(d.released_at.getTime() + LIMITS.releasedUploadUntilHours * 3600_000),
      });
    }
  }
  await c.tenant(d.company_id);
  const dev = { device_id: d.device_id, company_id: d.company_id, employee_id: d.employee_id, released: d.released };
  // A release outranks billing (D45); the uninstaller is never refused for billing (B17).
  if (d.released || kind === 'deactivate') return { dev, billing: null };
  return { dev, billing: await billingError(c, d.company_id, 'agent') };
}

// Agent routes answer COMPANY_SUSPENDED; the Downloader and enroll answer LICENSE_SUSPENDED.
export async function billingError(c: Tx, companyId: string, who: 'agent' | 'install'): Promise<ApiError | null> {
  const { rows } = await c.query(
    `SELECT c.status, l.expired_at + make_interval(days => c.expired_blocking_grace_days) AS blocking_ends_at
       FROM companies c LEFT JOIN licenses l ON l.company_id = c.id WHERE c.id = $1`,
    [companyId],
  );
  const r = rows[0];
  if (r?.status === 'suspended')
    return who === 'agent'
      ? new ApiError(402, 'COMPANY_SUSPENDED', 'Company suspended')
      : new ApiError(402, 'LICENSE_SUSPENDED', 'Licence suspended');
  if (r?.status === 'expired') return new ApiError(402, 'LICENSE_EXPIRED', 'Licence expired', { blocking_ends_at: r.blocking_ends_at });
  return null;
}

// policy_version = greatest(company, employee settings, device) (B5).
export async function policyVersion(c: Tx, dev: DeviceAuth): Promise<number> {
  const { rows } = await c.query(
    `SELECT greatest(c.policy_version, s.policy_version, d.policy_version) AS v
       FROM devices d JOIN companies c ON c.id = d.company_id
       JOIN employee_monitoring_settings s ON s.employee_id = d.employee_id
      WHERE d.id = $1`,
    [dev.device_id],
  );
  return rows[0].v;
}

// The pause in force now; with overlaps, the one ending last (D31).
export async function pauseInForce(c: Tx, employeeId: string) {
  const { rows } = await c.query(
    `SELECT id AS pause_id, starts_at, ends_at FROM monitoring_pauses
      WHERE employee_id = $1 AND cancelled_at IS NULL AND starts_at <= now() AND ends_at > now()
      ORDER BY ends_at DESC LIMIT 1`,
    [employeeId],
  );
  return rows[0] ?? null;
}

export function cmpVersion(a: string, b: string) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

// Newest non-withdrawn agent release for a platform (macOS ships one universal .pkg).
export async function newestRelease(c: Tx, os: string, arch: string) {
  const { rows } = await c.query(
    `SELECT version, min_supported, storage_path, sha256 FROM agent_releases
      WHERE product = 'agent' AND platform = $1 AND arch = $2 AND withdrawn_at IS NULL`,
    [os, os === 'macos' ? 'universal' : arch],
  );
  return rows.sort((x, y) => cmpVersion(y.version, x.version))[0] ?? null;
}
