// Signed-URL endpoints of the local storage (storage.ts): agents PUT screenshots, GET packages.
import { Controller, Get, Inject, Param, Put, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './core';
import { Bucket, Storage } from './storage';

const denied = () => new ApiError(403, 'FORBIDDEN', 'Signed URL invalid or expired');

@Controller('v1/storage')
export class StorageController {
  constructor(@Inject(Storage) private storage: Storage) {}

  @Put('screenshots/*')
  async put(@Param('*') path: string, @Query('exp') exp: string, @Query('sig') sig: string, @Req() req: FastifyRequest, @Res() res: FastifyReply) {
    if (!this.storage.verify('PUT', 'screenshots', path, exp, sig)) throw denied();
    if (req.headers['content-type'] !== 'image/jpeg' || !Buffer.isBuffer(req.body) || !req.body.length)
      throw new ApiError(422, 'VALIDATION_FAILED', 'Body must be an image/jpeg', { fields: ['content-type'] });
    await this.storage.put('screenshots', path, req.body);
    return res.status(200).send();
  }

  @Get('agents/*')
  async getPackage(@Param('*') path: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: FastifyReply) {
    return this.get('agents', 'application/octet-stream', path, exp, sig, res);
  }

  // Portal screenshot view links (screenshot-access), 5 minutes.
  @Get('screenshots/*')
  async getScreenshot(@Param('*') path: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: FastifyReply) {
    return this.get('screenshots', 'image/jpeg', path, exp, sig, res);
  }

  private async get(bucket: Bucket, type: string, path: string, exp: string, sig: string, res: FastifyReply) {
    if (!this.storage.verify('GET', bucket, path, exp, sig)) throw denied();
    const size = await this.storage.size(bucket, path);
    if (size === null) throw new ApiError(404, 'NOT_FOUND', 'Not found');
    return res.header('Content-Length', size).header('Cache-Control', 'private, no-store').type(type).send(this.storage.read(bucket, path));
  }
}
