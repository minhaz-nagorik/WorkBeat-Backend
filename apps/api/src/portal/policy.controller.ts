// Block rules, sensitive domains, productivity rules and the collection notice (serve-agent-policy).
// Triggers in 0001 raise companies.policy_version on every block-rule and sensitive-domain write.
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ADMIN, ADMIN_IT, ADMIN_MANAGER, ALL, idOrNone, portalUser } from '../auth';
import { ApiError, Db, parse } from '../core';

const NOTICE_MAX = 10_000;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
// Chrome URLBlocklist filter: [scheme://][.]host[:port][/path][?query]
const URL_FILTER = /^([a-z][a-z0-9+.-]*:\/\/)?\.?([a-z0-9-]+\.)*[a-z0-9-]+(:\d{1,5})?(\/[^\s?#]*)?(\?[^\s#]*)?$/i;

export const isBareHost = (p: string) => HOST.test(p) && !IPV4.test(p);

// regex input → url rules: ^(https?://)?(www\.)?(a\.com|b\.com)/path(.*)?$ style only (block-rules spec).
export function compileRegex(re: string): string[] | null {
  const m = /^\^?(?:https\?:\/\/)?(?:\(www\\\.\)\?)?(\([^()]+\)|[a-z0-9\\.-]+)((?:\/[^()*+?[\]{}|^$\\]*)?)(?:\.\*)?\$?$/i.exec(re.trim());
  if (!m) return null;
  const hosts = (m[1].startsWith('(') ? m[1].slice(1, -1).split('|') : [m[1]]).map((h) => h.replace(/\\\./g, '.').toLowerCase());
  if (!hosts.every((h) => isBareHost(h) && !/\\/.test(h))) return null;
  return hosts.map((h) => h + (m[2] || ''));
}

function validRule(type: 'domain' | 'url', pattern: string) {
  const ok = type === 'domain' ? isBareHost(pattern) : URL_FILTER.test(pattern) && pattern.length <= 2048;
  if (!ok) throw new ApiError(422, 'VALIDATION_FAILED', `Invalid ${type} pattern`, { fields: ['pattern'] });
}
const RULE = 'id, type, pattern, reason, created_at';

@Controller('v1')
export class PolicyController {
  constructor(@Inject(Db) private db: Db) {}

  @Get('block-rules')
  async blockRules(@Req() req: FastifyRequest) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, ALL);
      return { data: (await c.query(`SELECT r.id, r.type, r.pattern, r.reason, r.created_at, u.name AS created_by_name
        FROM block_rules r LEFT JOIN users u ON u.id = r.created_by ORDER BY r.created_at, r.id`)).rows };
    });
  }

  @Post('block-rules')
  async addBlockRule(@Req() req: FastifyRequest, @Body() raw: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN_IT);
      const b = parse(z.object({ type: z.enum(['domain', 'url', 'regex']), pattern: z.string().trim().min(1).max(2048), reason: z.string().max(500).nullish() }), raw);
      let rules: { type: 'domain' | 'url'; pattern: string }[];
      if (b.type === 'regex') {
        const urls = compileRegex(b.pattern);
        if (!urls) throw new ApiError(422, 'VALIDATION_FAILED', 'Regex cannot be turned into URL rules', { fields: ['pattern'] });
        rules = urls.map((p) => ({ type: 'url', pattern: p }));
      } else rules = [{ type: b.type, pattern: b.type === 'domain' ? b.pattern.toLowerCase() : b.pattern }];
      rules.forEach((r) => validRule(r.type, r.pattern));
      const out = [];
      for (const r of rules) // block_rules_unique → 409
        out.push((await c.query(`INSERT INTO block_rules (company_id, type, pattern, reason, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING ${RULE}`,
          [u.company_id, r.type, r.pattern, b.reason ?? null, u.id])).rows[0]);
      res.status(201);
      return { data: b.type === 'regex' ? out : out[0] };
    });
  }

  @Patch('block-rules/:id')
  async patchBlockRule(@Req() req: FastifyRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN_IT);
      const b = parse(z.object({ pattern: z.string().trim().min(1).max(2048).optional(), reason: z.string().max(500).nullish() }), raw);
      const { rows: [cur] } = await c.query('SELECT id, type FROM block_rules WHERE id = $1', [idOrNone(id)]);
      if (!cur) throw new ApiError(404, 'NOT_FOUND', 'Rule not found');
      const pattern = b.pattern && cur.type === 'domain' ? b.pattern.toLowerCase() : b.pattern;
      if (pattern) validRule(cur.type, pattern);
      const { rows: [r] } = await c.query(
        `UPDATE block_rules SET pattern = coalesce($2, pattern), reason = CASE WHEN $3 THEN $4 ELSE reason END WHERE id = $1 RETURNING ${RULE}`,
        [cur.id, pattern ?? null, 'reason' in b, b.reason ?? null],
      );
      return { data: r };
    });
  }

  @Delete('block-rules/:id')
  async deleteBlockRule(@Req() req: FastifyRequest, @Param('id') id: string, @Res({ passthrough: true }) res: FastifyReply) {
    await this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN_IT);
      if (!(await c.query('DELETE FROM block_rules WHERE id = $1', [idOrNone(id)])).rowCount) throw new ApiError(404, 'NOT_FOUND', 'Rule not found');
    });
    res.status(204);
  }

  @Get('sensitive-domains')
  async sensitive(@Req() req: FastifyRequest) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, ALL);
      return { data: (await c.query('SELECT id, pattern, is_default, created_at FROM sensitive_domains ORDER BY lower(pattern)')).rows };
    });
  }

  @Post('sensitive-domains')
  async addSensitive(@Req() req: FastifyRequest, @Body() raw: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN);
      const { pattern } = parse(z.object({ pattern: z.string().trim().toLowerCase().min(1).max(253) }), raw);
      if (!isBareHost(pattern)) throw new ApiError(422, 'VALIDATION_FAILED', 'Must be a bare host name', { fields: ['pattern'] });
      const { rows: [r] } = await c.query(
        'INSERT INTO sensitive_domains (company_id, pattern, created_by) VALUES ($1, $2, $3) RETURNING id, pattern, is_default, created_at',
        [u.company_id, pattern, u.id],
      );
      res.status(201);
      return { data: r };
    });
  }

  @Delete('sensitive-domains/:id')
  async deleteSensitive(@Req() req: FastifyRequest, @Param('id') id: string, @Res({ passthrough: true }) res: FastifyReply) {
    await this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      if (!(await c.query('DELETE FROM sensitive_domains WHERE id = $1', [idOrNone(id)])).rowCount) throw new ApiError(404, 'NOT_FOUND', 'Not found');
    });
    res.status(204);
  }

  @Get('productivity-rules')
  async productivity(@Req() req: FastifyRequest) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, ALL);
      return { data: (await c.query('SELECT id, match_type, pattern, category FROM productivity_rules ORDER BY match_type, lower(pattern)')).rows };
    });
  }

  @Post('productivity-rules')
  async addProductivity(@Req() req: FastifyRequest, @Body() raw: unknown, @Res({ passthrough: true }) res: FastifyReply) {
    return this.db.tx(async (c) => {
      const u = await portalUser(c, req, ADMIN);
      const b = parse(z.object({ match_type: z.enum(['app', 'domain']), pattern: z.string().trim().min(1).max(512), category: z.enum(['productive', 'neutral', 'unproductive']) }), raw);
      const pattern = b.match_type === 'domain' ? b.pattern.toLowerCase() : b.pattern;
      if (b.match_type === 'domain' && !isBareHost(pattern)) throw new ApiError(422, 'VALIDATION_FAILED', 'Must be a bare host name', { fields: ['pattern'] });
      const { rows: [r] } = await c.query(
        'INSERT INTO productivity_rules (company_id, match_type, pattern, category, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, match_type, pattern, category',
        [u.company_id, b.match_type, pattern, b.category, u.id],
      );
      res.status(201);
      return { data: r };
    });
  }

  @Patch('productivity-rules/:id')
  async patchProductivity(@Req() req: FastifyRequest, @Param('id') id: string, @Body() raw: unknown) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      const b = parse(z.object({ category: z.enum(['productive', 'neutral', 'unproductive']) }), raw);
      const { rows: [r] } = await c.query('UPDATE productivity_rules SET category = $2 WHERE id = $1 RETURNING id, match_type, pattern, category', [idOrNone(id), b.category]);
      if (!r) throw new ApiError(404, 'NOT_FOUND', 'Rule not found');
      return { data: r };
    });
  }

  @Delete('productivity-rules/:id')
  async deleteProductivity(@Req() req: FastifyRequest, @Param('id') id: string, @Res({ passthrough: true }) res: FastifyReply) {
    await this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      if (!(await c.query('DELETE FROM productivity_rules WHERE id = $1', [idOrNone(id)])).rowCount) throw new ApiError(404, 'NOT_FOUND', 'Rule not found');
    });
    res.status(204);
  }

  @Get('settings/notice')
  async notice(@Req() req: FastifyRequest) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      return { data: (await c.query('SELECT notice_text, notice_version FROM companies')).rows[0] };
    });
  }

  @Put('settings/notice')
  async putNotice(@Req() req: FastifyRequest, @Body() raw: unknown) {
    return this.db.tx(async (c) => {
      await portalUser(c, req, ADMIN);
      const b = parse(z.object({ notice_text: z.string().trim().min(1).max(NOTICE_MAX) }), raw, 422);
      // A changed text raises notice_version; the companies_policy trigger raises policy_version.
      const { rows: [r] } = await c.query(
        `UPDATE companies SET notice_text = $1, notice_version = notice_version + CASE WHEN notice_text = $1 THEN 0 ELSE 1 END
          WHERE id = app_company_id() RETURNING notice_text, notice_version`,
        [b.notice_text],
      );
      return { data: r };
    });
  }
}
