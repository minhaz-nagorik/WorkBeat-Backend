import 'reflect-metadata';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AgentsController } from './agents.controller';
import { setInjector } from './changes';
import { LIMITS } from './contract';
import { ApiError, config, Db, fromDbError, sha256 } from './core';
import type { LogCtx } from './http';
import { InstallController } from './install.controller';
import { PolicyEvents } from './policy-events';
import { Storage } from './storage';
import { StorageController } from './storage.controller';
import { CronController } from './cron.controller';
import { ChangesController } from './portal/changes.controller';
import { CompanyController } from './portal/company.controller';
import { DevicesController } from './portal/devices.controller';
import { EmployeesController } from './portal/employees.controller';
import { PolicyController } from './portal/policy.controller';
import { ReportsController } from './portal/reports.controller';
import { RolesController } from './portal/roles.controller';
import { SessionController } from './portal/session.controller';
import { StaffController } from './portal/staff.controller';

// Unauthenticated routes that guess secrets get the tight per-IP limit.
const TIGHT = ['/v1/license/validate', '/v1/auth/', '/api/v1/license/validate', '/v1/invitations/'];

const AGENT_PACKAGE_MAX_BYTES = 300 * 1024 * 1024;

const cfg = config();
const db = new Db(cfg.DATABASE_URL);
const storage = new Storage(cfg.STORAGE_DIR, cfg.SECRETS_ENCRYPTION_KEY, {
  endpoint: cfg.R2_ENDPOINT, accessKeyId: cfg.R2_ACCESS_KEY_ID, secretAccessKey: cfg.R2_SECRET_ACCESS_KEY, bucket: cfg.R2_SCREENSHOTS_BUCKET,
});
const policyEvents = PolicyEvents.forDb(db, storage);

// Every error → { error, code } (api-envelope). Unknown errors → 500 INTERNAL with nothing leaked.
function toApiError(e: any): ApiError {
  if (e instanceof ApiError) return e;
  const db = fromDbError(e);
  if (db) return db;
  const status = e instanceof HttpException ? e.getStatus() : e?.statusCode;
  if (status === 413) return new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Body too large');
  if (status === 429) return new ApiError(429, 'RATE_LIMITED', 'Too many requests');
  if (status === 404) return new ApiError(404, 'NOT_FOUND', 'Not found');
  if (status === 400 || status === 415) return new ApiError(400, 'VALIDATION_FAILED', 'Malformed request');
  // Name and pg code only: messages and details can carry request values (api-logging).
  console.error(JSON.stringify({ t: new Date(), level: 'error', err: e?.name, pg_code: e?.code, at: e?.stack?.split('\n')[1]?.trim() }));
  return new ApiError(500, 'INTERNAL', 'Internal error');
}

function send(reply: FastifyReply, req: FastifyRequest, e: unknown) {
  const err = toApiError(e);
  (req as FastifyRequest & { wb?: LogCtx }).wb = { ...(req as any).wb, code: err.code };
  return reply.status(err.status).type('application/json').send(err.body());
}

@Catch()
class AllErrors implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    send(http.getResponse(), http.getRequest(), e);
  }
}

@Module({
  controllers: [InstallController, AgentsController, StorageController, SessionController, CompanyController,
    EmployeesController, DevicesController, PolicyController, ReportsController, StaffController, ChangesController, RolesController, CronController],
  providers: [
    { provide: Db, useValue: db },
    { provide: Storage, useValue: storage },
    { provide: PolicyEvents, useValue: policyEvents },
  ],
})
class AppModule {}

async function main() {
  const adapter = new FastifyAdapter({
    bodyLimit: LIMITS.bodyBytes,
    // Only a proxy on this host (cloudflared, nginx) is trusted for X-Forwarded-*: a client-sent
    // X-Forwarded-For can then not fake the IP the rate limits key on.
    trustProxy: ['127.0.0.1', '::1'],
    // The agents' specs use a base URL ending in /api/v1: /api/v1/... is served as /v1/...
    rewriteUrl: (req: { url?: string }) => (req.url?.startsWith('/api/v1/') ? req.url.slice(4) : req.url ?? '/'),
    genReqId: (req: { headers: Record<string, unknown> }) => {
      const id = req.headers['x-request-id'];
      return typeof id === 'string' && /^[\w.-]{1,128}$/.test(id) ? id : randomUUID();
    },
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { logger: ['error', 'warn'] });
  const f = app.getHttpAdapter().getInstance();
  setInjector((o) => f.inject(o as any) as any);

  f.addHook('onRoute', (r) => {
    if (r.url === '/v1/agents/activity') r.bodyLimit = LIMITS.activityBodyBytes;
    if (r.url.startsWith('/v1/storage/agents')) r.bodyLimit = AGENT_PACKAGE_MAX_BYTES;
  });
  // shortcut: the whole installer is buffered in memory; stream to disk (or presign S3) if packages grow past ~100 MB.
  f.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  f.addContentTypeParser('text/csv', { parseAs: 'string', bodyLimit: 2 * 1024 * 1024 }, (_req, body, done) => done(null, body)); // employee import
  f.addHook('onRequest', async (req, reply) => {
    reply.header('X-Request-Id', req.id);
  });
  // One structured line per request; never headers, bodies, URLs with signatures or secrets (api-logging).
  f.addHook('onResponse', async (req, reply) => {
    const wb = (req as FastifyRequest & { wb?: LogCtx }).wb ?? {};
    console.log(JSON.stringify({
      t: new Date(), request_id: req.id, method: req.method, route: req.routeOptions.url ?? 'unmatched',
      status: reply.statusCode, code: wb.code, ms: Math.round(reply.elapsedTime), scope: wb.scope ?? 'none',
      company_id: wb.company_id, device_id: wb.device_id,
    }));
  });

  // Per credential; unauthenticated routes per IP (rate-limiting). Keys are hashed, never kept raw.
  await f.register(rateLimit, {
    global: true,
    timeWindow: 60_000,
    keyGenerator: (req) => {
      const tight = TIGHT.find((p) => req.url.startsWith(p));
      const dev = req.headers['x-device-key'], auth = req.headers.authorization;
      if (typeof dev === 'string' && !tight) return 'dev:' + sha256(dev); // per device key
      if (typeof auth === 'string' && !tight) return 'usr:' + sha256(auth); // per user session (or enrollment token)
      return (tight ? `lic:${tight}:` : 'ip:') + req.ip; // one bucket per sensitive route group
    },
    max: (_req, key) => (key.startsWith('dev:') ? LIMITS.ratePerDeviceKey : key.startsWith('usr:') ? LIMITS.ratePerSession
      : key.startsWith('lic:') ? LIMITS.ratePerIpLicense : LIMITS.ratePerIp),
    errorResponseBuilder: (_req, ctx) => ({ statusCode: 429, retryAfter: ctx.after }),
  });

  app.useGlobalFilters(new AllErrors());
  policyEvents.listen(cfg.DATABASE_URL); // one LISTEN connection, outside the pool (B32)
  await app.listen(cfg.PORT, '0.0.0.0');
  console.log(JSON.stringify({ t: new Date(), level: 'info', msg: `WorkBeat API on :${cfg.PORT}` }));
}
main();
