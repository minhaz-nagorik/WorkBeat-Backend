// Signed-URL endpoints of the local storage (storage.ts): agents GET packages, staff PUT packages. Screenshots are in R2.
import { Controller, Get, Inject, Param, Put, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './core';
import { Storage } from './storage';

const denied = () => new ApiError(403, 'FORBIDDEN', 'Signed URL invalid or expired');

@Controller('v1/storage')
export class StorageController {
  constructor(@Inject(Storage) private storage: Storage) {}

  // Staff upload an installer to the URL from POST /v1/staff/agent-releases/upload-url.
  @Put('agents/*')
  async putPackage(@Param('*') path: string, @Query('exp') exp: string, @Query('sig') sig: string, @Req() req: FastifyRequest, @Res() res: FastifyReply) {
    if (!this.storage.verify('PUT', 'agents', path, exp, sig)) throw denied();
    if (!Buffer.isBuffer(req.body) || !req.body.length)
      throw new ApiError(422, 'VALIDATION_FAILED', 'Body must be application/octet-stream', { fields: ['content-type'] });
    await this.storage.put('agents', path, req.body);
    return res.status(200).send();
  }

  @Get('agents/*')
  async getPackage(@Param('*') path: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: FastifyReply) {
    if (!this.storage.verify('GET', 'agents', path, exp, sig)) throw denied();
    const size = await this.storage.size('agents', path);
    if (size === null) throw new ApiError(404, 'NOT_FOUND', 'Not found');
    return res.header('Content-Length', size).header('Cache-Control', 'private, no-store').type('application/octet-stream').send(this.storage.read('agents', path));
  }
}
