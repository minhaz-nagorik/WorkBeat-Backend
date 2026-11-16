// /health, the Downloader's /license/validate, and the agent's enroll and deactivate.
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { enrollBody, licenseValidateBody, LIMITS, normaliseLicenceKey, uuid } from './contract';
import { ApiError, Db, fromDbError, parse, sha256, token } from './core';
import { authDevice, billingError, newestRelease } from './device';
import { Storage } from './storage';
import { baseUrl, tag } from './http';
import { deactivateAsUser } from './portal/devices.controller';

@Controller()
export class InstallController {
  constructor(@Inject(Db) private db: Db, @Inject(Storage) private storage: Storage) {}

  @Get('health')
  async health() {
    try {
      await this.db.pool.query('SELECT 1');
      return { data: { status: 'ok' } };
    } catch {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Database unreachable');
    }
  }

  // enroll-devices/license-validation. Step 1: company + employees. Step 2 (employee_id): + token.
  @Post('v1/license/validate')
  @HttpCode(200)
  async validate(@Req() req: FastifyRequest, @Headers('x-license-key') key: string | undefined, @Body() raw: unknown) {
    return this.db.tx(async (c) => {
      const lic = key ? (await c.query('SELECT * FROM auth_license($1)', [sha256(normaliseLicenceKey(key))])).rows[0] : null;
      if (!lic) throw new ApiError(404, 'LICENSE_NOT_FOUND', 'Licence key not found');
      await c.tenant(lic.company_id);
      tag(req, { company_id: lic.company_id });
      const billing = await billingError(c, lic.company_id, 'install');
      if (billing) throw billing;
      const body = parse(licenseValidateBody, raw ?? {}, 400);

      const { rows: [seat] } = await c.query(
        `SELECT l.seat_limit, c.name,
                (SELECT count(*)::int FROM devices d WHERE d.company_id = c.id AND d.deactivated_at IS NULL AND d.released_at IS NULL) AS used
           FROM licenses l JOIN companies c ON c.id = l.company_id WHERE l.id = $1`,
        [lic.license_id],
      );
      if (seat.seat_limit !== null && seat.used >= seat.seat_limit) throw new ApiError(403, 'SEAT_LIMIT_EXCEEDED', 'No free seat');

      const { rows: employees } = await c.query(
        'SELECT id, name, email, department FROM employees WHERE archived_at IS NULL ORDER BY name, id',
      );
      const data: Record<string, unknown> = { company_name: seat.name, employees };
      if (!body.employee_id) return { data };

      if (!employees.some((e) => e.id === body.employee_id)) throw new ApiError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
      const t = token('wbe_');
      const { rows: [row] } = await c.query(
        `INSERT INTO enrollment_tokens (company_id, license_id, token_hash, employee_id, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5)) RETURNING expires_at`,
        [lic.company_id, lic.license_id, sha256(t), body.employee_id, LIMITS.enrollmentTokenHours],
      );
      let pkg = null;
      if (body.os && body.arch) pkg = await newestRelease(c, body.os, body.arch);
      const exp = Math.floor(Date.now() / 1000) + LIMITS.packageUrlSeconds;
      return {
        data: {
          ...data,
          enrollment_token: t,
          expires_at: row.expires_at,
          package_url: pkg ? this.storage.sign(baseUrl(req), 'GET', 'agents', pkg.storage_path, exp) : null,
          package_sha256: pkg?.sha256 ?? null,
        },
      };
    });
  }

  // enroll-devices/device-enrollment. Order: token, standing, employee, binding, seat.
  @Post('v1/devices/enroll')
  async enroll(@Req() req: FastifyRequest, @Headers('authorization') auth: string | undefined, @Body() raw: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    const presented = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    try {
      return await this.db.tx(async (c) => {
        const tok = presented ? (await c.query('SELECT * FROM auth_enrollment_token($1)', [sha256(presented)])).rows[0] : null;
        if (!tok) throw new ApiError(404, 'ENROLLMENT_TOKEN_INVALID', 'Enrollment token not found');
        if (tok.used) throw new ApiError(403, 'ENROLLMENT_TOKEN_EXHAUSTED', 'Enrollment token already used');
        if (tok.expired) throw new ApiError(403, 'ENROLLMENT_TOKEN_EXPIRED', 'Enrollment token expired');
        const body = parse(enrollBody, raw, 400);
        if (body.employee_id && body.employee_id !== tok.employee_id)
          throw new ApiError(422, 'VALIDATION_FAILED', 'employee_id does not match the token', { fields: ['employee_id'] });

        await c.tenant(tok.company_id);
        tag(req, { company_id: tok.company_id });
        const billing = await billingError(c, tok.company_id, 'install');
        if (billing) throw billing;
        const emp = await c.query('SELECT 1 FROM employees WHERE id = $1 AND archived_at IS NULL', [tok.employee_id]);
        if (!emp.rowCount) throw new ApiError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');

        // Claim the token; a concurrent use of it waits here and then finds it used.
        const claimed = await c.query('UPDATE enrollment_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL', [tok.token_id]);
        if (!claimed.rowCount) throw new ApiError(403, 'ENROLLMENT_TOKEN_EXHAUSTED', 'Enrollment token already used');
        res.status(201); // both outcomes answer 201

        // Serialise enrollments of one device ID in one company, so racing installs share one row.
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${tok.company_id}/${body.hardware_id}`]);
        const { rows: [live] } = await c.query(
          'SELECT id, employee_id, last_heartbeat_at FROM devices WHERE hardware_id = $1 AND released_at IS NULL',
          [body.hardware_id],
        );
        const key = token('wbd_');
        const ident = [body.hostname, body.os, body.os_version, body.arch, body.model ?? null, body.serial_number ?? null, body.agent_version];

        if (live && live.employee_id !== tok.employee_id)
          throw new ApiError(409, 'DEVICE_ASSIGNED', 'Device is bound to another employee; release it first');

        if (live) {
          const dupMs = LIMITS.duplicateHeartbeatMinutes * 60_000;
          if (live.last_heartbeat_at && Date.now() - live.last_heartbeat_at.getTime() < dupMs) {
            await c.query(
              `INSERT INTO tamper_events (id, company_id, device_id, hostname, event_type, detail, occurred_at)
               SELECT gen_random_uuid(), company_id, id, hostname, 'duplicate_device_id', '{}', now() FROM devices WHERE id = $1`,
              [live.id],
            );
          }
          await c.query(
            `UPDATE devices SET key_hash = $2, key_issued_at = now(), deactivated_at = NULL, enrollment_token_id = $3,
                    hostname = $4, os = $5, os_version = $6, arch = $7, model = $8, serial_number = $9, agent_version = $10
              WHERE id = $1`,
            [live.id, sha256(key), tok.token_id, ...ident],
          );
          tag(req, { device_id: live.id });
          return { data: { device_id: live.id, device_key: key, outcome: 'same_binding', notice_required: false } };
        }

        const { rows: [dev] } = await c.query(
          `INSERT INTO devices (company_id, employee_id, enrollment_token_id, key_hash, key_issued_at, hostname, os, os_version,
                                arch, model, serial_number, agent_version, hardware_id, enrolled_via)
           VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8, $9, $10, $11, $12, 'manual') RETURNING id`,
          [tok.company_id, tok.employee_id, tok.token_id, sha256(key), ...ident, body.hardware_id],
        );
        tag(req, { device_id: dev.id });
        return { data: { device_id: dev.id, device_key: key, outcome: 'new_binding', notice_required: true } };
      });
    } catch (e) {
      throw fromDbError(e) ?? e;
    }
  }

  // The uninstaller (X-Device-Key) frees its seat (D19), never answered 402 (B17); a portal user
  // (Bearer session) deactivates any device of the company and gets the device back.
  @Post('v1/devices/:id/deactivate')
  async deactivate(@Req() req: FastifyRequest, @Param('id') id: string, @Headers('x-device-key') key: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    if (!key && req.headers.authorization) {
      res.status(200);
      return { data: await this.db.tx((c) => deactivateAsUser(c, req, id)) };
    }
    await this.db.tx(async (c) => {
      const { dev } = await authDevice(c, key, 'deactivate');
      tag(req, dev);
      if (!uuid.safeParse(id).success || id !== dev.device_id) throw new ApiError(403, 'FORBIDDEN', 'Not this device');
      await c.query('UPDATE devices SET deactivated_at = coalesce(deactivated_at, now()), key_hash = NULL WHERE id = $1', [dev.device_id]);
    });
    res.status(204);
  }
}
