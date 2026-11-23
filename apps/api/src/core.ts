// Config, errors, crypto and the per-request transaction.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Pool, PoolClient, types } from 'pg';
import { z, ZodType } from 'zod';

// ---------------------------------------------------------------- config

const env = z
  .object({
    DATABASE_URL: z.string().url(), // the API login role (member of workbeat_api, never a superuser)
    SECRETS_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, '32 bytes, base64'),
    STORAGE_DIR: z.string().default('./storage'),
    // Screenshots live only in Cloudflare R2.
    R2_ENDPOINT: z.string().url(), // https://<account_id>.r2.cloudflarestorage.com
    R2_ACCESS_KEY_ID: z.string().min(1),
    R2_SECRET_ACCESS_KEY: z.string().min(1),
    R2_SCREENSHOTS_BUCKET: z.string().min(1),
    PUBLIC_BASE_URL: z.string().url().optional(), // else taken from the request host (tunnel)
    PORT: z.coerce.number().int().default(3000),
    RESEND_API_KEY: z.string().optional(), // unset: emails go to STORAGE_DIR/outbox (local only)
    EMAIL_FROM: z.string().default('WorkBeat <no-reply@workbeat.io>'),
    PORTAL_URL: z.string().url().default('http://localhost:3001'), // links in emails
    CRON_SECRET: z.string().min(32).optional(), // X-Cron-Secret for /cron/*; unset: every cron call is 401
  })
  .safeParse(process.env);

export function config() {
  if (!env.success) {
    console.error('Invalid environment:', env.error.issues.map((i) => i.path.join('.')).join(', '));
    process.exit(1);
  }
  return env.data;
}

// ---------------------------------------------------------------- errors

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
  body(): Record<string, unknown> {
    return { error: this.message, code: this.code, ...this.extra };
  }
}

// 400 for missing fields and wrong types, 422 for well-formed but wrong values, unless the route's spec fixes it.
export function parse<T>(schema: ZodType<T, any, any>, data: unknown, status?: 400 | 422): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const st = status ?? (r.error.issues.some((i) => i.code === 'invalid_type') ? 400 : 422);
  const fields = [...new Set(r.error.issues.map((i) => i.path.join('.') || '(body)'))];
  throw new ApiError(st, 'VALIDATION_FAILED', 'Request failed validation', { fields });
}

// Database raises these by message from triggers (0001–0003).
const DB_CODES: Record<string, [number, string]> = {
  SEAT_LIMIT_EXCEEDED: [403, 'SEAT_LIMIT_EXCEEDED'],
  LICENSE_NOT_FOUND: [404, 'LICENSE_NOT_FOUND'],
  EMPLOYEE_HAS_DEVICES: [409, 'EMPLOYEE_HAS_DEVICES'],
  FORBIDDEN: [403, 'FORBIDDEN'],
};
export function fromDbError(e: any): ApiError | null {
  if (e?.code === 'P0001' && DB_CODES[e.message]) {
    const [s, c] = DB_CODES[e.message];
    return new ApiError(s, c, c.toLowerCase().replace(/_/g, ' '));
  }
  if (e?.code === '23505' || e?.code === '23P01') return new ApiError(409, 'CONFLICT', 'Conflicts with an existing record');
  if (e?.code === '23514') return new ApiError(422, 'VALIDATION_FAILED', 'Value out of range');
  return null;
}

// ---------------------------------------------------------------- crypto

export const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export const token = (prefix: string) => prefix + randomBytes(32).toString('base64url');

// AES-256-GCM, stored as iv(12) | tag(16) | ciphertext (B6).
export function encrypt(plain: string, keyB64: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function decrypt(blob: Buffer, keyB64: string): string {
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------- database

types.setTypeParser(20, Number); // bigint (policy_version) fits a JS number

// dryRun: set for a write that must wait for approval (changes.ts); called after the rollback.
export type Tx = PoolClient & { tenant(companyId: string): Promise<void>; dryRun?: (result: unknown) => Promise<never> };

export class Db {
  pool: Pool;
  constructor(url: string) {
    // Bounded waits: no request waits forever for a connection or runs one statement forever.
    // No idle-in-transaction limit: approve keeps its transaction open while the replay runs (changes.controller).
    // work_mem 32MB: big reports sort in memory instead of on disk (20 connections fit 4–8 GB RAM).
    this.pool = new Pool({ connectionString: url, max: 20, connectionTimeoutMillis: 10_000, statement_timeout: 60_000,
      options: '-c work_mem=32MB' });
  }

  // One transaction per request (B2). Starts with no scope; credential lookups go through the
  // SECURITY DEFINER auth_* functions, then tenant() binds the company for the rest.
  async tx<T>(fn: (c: Tx) => Promise<T>, opts: { snapshot?: boolean } = {}): Promise<T> {
    const c = (await this.pool.connect()) as Tx;
    c.tenant = async (companyId) => {
      await c.query("SELECT set_config('app.scope', 'tenant', true), set_config('app.company_id', $1, true)", [companyId]);
    };
    try {
      await c.query(opts.snapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
      const r = await fn(c);
      if (c.dryRun) {
        await c.query('ROLLBACK');
        const store = c.dryRun;
        c.dryRun = undefined;
        return await store(r);
      }
      await c.query('COMMIT');
      return r;
    } catch (e) {
      if (!(e as { status?: number })?.status || (e as { status: number }).status !== 202) await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.dryRun = undefined; // pooled clients are reused: never carry a deferral into the next request
      c.release();
    }
  }
}
