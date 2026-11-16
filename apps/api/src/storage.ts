// Private object storage with signed URLs.
// shortcut: local disk on one instance; replace with S3 (or similar) presigned URLs once the
// bucket provider is chosen — callers only use sign/stat/remove/put/read.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type Bucket = 'screenshots' | 'agents';
const SAFE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export class Storage {
  private key: Buffer;
  constructor(private root: string, secretB64: string) {
    this.key = createHmac('sha256', Buffer.from(secretB64, 'base64')).update('storage-url-signing').digest();
  }

  private file(bucket: Bucket, path: string) {
    if (!SAFE_PATH.test(path) || path.split('/').some((p) => p === '..' || p === '.')) throw new Error('bad storage path');
    return join(this.root, bucket, path);
  }

  private mac(method: string, bucket: Bucket, path: string, exp: number) {
    return createHmac('sha256', this.key).update(`${method}\n${bucket}\n${path}\n${exp}`).digest('base64url');
  }

  // exp: Unix seconds. Same inputs → same URL, which keeps the policy ETag stable within a day.
  sign(base: string, method: 'GET' | 'PUT', bucket: Bucket, path: string, exp: number) {
    return `${base}/v1/storage/${bucket}/${path}?exp=${exp}&sig=${this.mac(method, bucket, path, exp)}`;
  }

  verify(method: string, bucket: Bucket, path: string, exp: string, sig: string) {
    const e = Number(exp);
    if (!Number.isInteger(e) || e < Date.now() / 1000 || !SAFE_PATH.test(path)) return false;
    const want = Buffer.from(this.mac(method, bucket, path, e));
    const got = Buffer.from(String(sig));
    return want.length === got.length && timingSafeEqual(want, got);
  }

  async put(bucket: Bucket, path: string, body: Buffer) {
    const f = this.file(bucket, path);
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f + '.part', body);
    await rename(f + '.part', f); // a confirm never sees half a file
  }

  async size(bucket: Bucket, path: string): Promise<number | null> {
    return stat(this.file(bucket, path)).then((s) => s.size, () => null);
  }

  remove(bucket: Bucket, path: string) {
    return rm(this.file(bucket, path), { force: true });
  }

  read(bucket: Bucket, path: string) {
    return createReadStream(this.file(bucket, path));
  }
}
