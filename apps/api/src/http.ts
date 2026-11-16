// Request helpers: the public base URL for signed links and the log context of a request.
import type { FastifyRequest } from 'fastify';

export const baseUrl = (req: FastifyRequest) => process.env.PUBLIC_BASE_URL?.replace(/\/$/, '') ?? `${req.protocol}://${req.host}`;

export type LogCtx = { scope?: string; company_id?: string; device_id?: string; code?: string };
export function tag(req: FastifyRequest, ctx: LogCtx) {
  const r = req as FastifyRequest & { wb?: LogCtx };
  r.wb = { ...r.wb, scope: 'tenant', ...ctx };
}
