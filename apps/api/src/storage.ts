// Private object storage with signed URLs. Screenshots live only in Cloudflare R2 (B26); agent
// packages stay on local disk. Callers only use sign/size/remove/put/read.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type Bucket = 'screenshots' | 'agents';
const SAFE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,200}$/; // download file names: safe inside a quoted header value

export type R2 = { endpoint: string; accessKeyId: string; secretAccessKey: string; bucket: string };

const hmac = (k: Buffer | string, v: string) => createHmac('sha256', k).update(v).digest();
const enc = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// AWS SigV4 query-string presigning (what R2's S3 API accepts). `path` is the raw URI path.
export function presign(o: {
  method: string; host: string; path: string; region: string; accessKeyId: string; secretAccessKey: string;
  date: Date; expires: number; headers?: Record<string, string>; query?: Record<string, string>;
}) {
  const amzDate = o.date.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const scope = `${amzDate.slice(0, 8)}/${o.region}/s3/aws4_request`;
  const headers: Record<string, string> = { ...o.headers, host: o.host };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim()]));
  const query = Object.entries({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${o.accessKeyId}/${scope}`, 'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(o.expires), 'X-Amz-SignedHeaders': names.join(';'), ...o.query,
  }).map(([k, v]) => `${enc(k)}=${enc(v)}`).sort().join('&');
  const uri = o.path.split('/').map(enc).join('/');
  const creq = [o.method, uri, query, names.map((h) => `${h}:${lower[h]}\n`).join(''), names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(creq).digest('hex')].join('\n');
  const kSign = [amzDate.slice(0, 8), o.region, 's3', 'aws4_request'].reduce<Buffer>((k, v) => hmac(k, v), Buffer.from('AWS4' + o.secretAccessKey));
  return `https://${o.host}${uri}?${query}&X-Amz-Signature=${hmac(kSign, sts).toString('hex')}`;
}

export class Storage {
  private key: Buffer;
  constructor(private root: string, secretB64: string, private r2: R2) {
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
  // download (screenshots only): a GET R2 answers as an attachment with that file name.
  sign(base: string, method: 'GET' | 'PUT', bucket: Bucket, path: string, exp: number, download?: string) {
    if (download !== undefined && (method !== 'GET' || bucket !== 'screenshots' || !SAFE_NAME.test(download))) throw new Error('bad download name');
    if (bucket === 'screenshots') {
      const now = Math.floor(Date.now() / 1000);
      // PUT signs Content-Type, so R2 refuses anything but a JPEG, as the local endpoint does.
      return this.r2Url(method, path, Math.max(1, exp - now), method === 'PUT' ? { 'content-type': 'image/jpeg' } : undefined,
        download ? { 'response-content-disposition': `attachment; filename="${download}"`, 'response-content-type': 'image/jpeg' } : undefined);
    }
    return `${base}/v1/storage/${bucket}/${path}?exp=${exp}&sig=${this.mac(method, bucket, path, exp)}`;
  }

  verify(method: string, bucket: Bucket, path: string, exp: string, sig: string) {
    const e = Number(exp);
    if (!Number.isInteger(e) || e < Date.now() / 1000 || !SAFE_PATH.test(path)) return false;
    const want = Buffer.from(this.mac(method, bucket, path, e));
    const got = Buffer.from(String(sig));
    return want.length === got.length && timingSafeEqual(want, got);
  }

  private r2Url(method: string, path: string, expires: number, headers?: Record<string, string>, query?: Record<string, string>) {
    this.file('screenshots', path); // path validation only
    const r2 = this.r2;
    return presign({ method, host: new URL(r2.endpoint).host, path: `/${r2.bucket}/${path}`, region: 'auto',
      accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey, date: new Date(), expires, headers, query });
  }

  async put(bucket: 'agents', path: string, body: Buffer) {
    const f = this.file(bucket, path);
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f + '.part', body);
    await rename(f + '.part', f); // a confirm never sees half a file
  }

  async size(bucket: Bucket, path: string): Promise<number | null> {
    if (bucket === 'screenshots') {
      const r = await fetch(this.r2Url('HEAD', path, 60), { method: 'HEAD' });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`R2 HEAD ${r.status}`);
      return Number(r.headers.get('content-length'));
    }
    return stat(this.file(bucket, path)).then((s) => s.size, () => null);
  }

  async remove(bucket: Bucket, path: string) {
    if (bucket === 'screenshots') {
      const r = await fetch(this.r2Url('DELETE', path, 60), { method: 'DELETE' });
      if (!r.ok && r.status !== 404) throw new Error(`R2 DELETE ${r.status}`);
      return;
    }
    return rm(this.file(bucket, path), { force: true });
  }

  read(bucket: 'agents', path: string) {
    return createReadStream(this.file(bucket, path));
  }
}
