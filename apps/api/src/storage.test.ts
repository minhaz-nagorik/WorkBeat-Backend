import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presign, Storage } from './storage';

test('SigV4 presign matches the AWS S3 documentation example', () => {
  const url = presign({
    method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    date: new Date('2013-05-24T00:00:00Z'), expires: 86400,
  });
  assert.ok(url.endsWith('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'), url);
});

const KEY = Buffer.alloc(32, 7).toString('base64');
const exp = () => Math.floor(Date.now() / 1000) + 300;

test('R2 download link carries both response-* parameters', () => {
  const s = new Storage('/tmp/x', KEY, { endpoint: 'https://acc.r2.cloudflarestorage.com', accessKeyId: 'AK', secretAccessKey: 'SK', bucket: 'b' });
  const u = new URL(s.sign('http://h', 'GET', 'screenshots', 'c/a.jpg', exp(), 'mac-2026-11-17-0930.jpg'));
  assert.equal(u.searchParams.get('response-content-disposition'), 'attachment; filename="mac-2026-11-17-0930.jpg"');
  assert.equal(u.searchParams.get('response-content-type'), 'image/jpeg');
  assert.ok(u.searchParams.get('X-Amz-Signature'));
  assert.throws(() => s.sign('http://h', 'GET', 'screenshots', 'c/a.jpg', exp(), 'a"b.jpg'));
  assert.throws(() => s.sign('http://h', 'GET', 'agents', 'p.pkg', exp(), 'p.pkg'));
  assert.equal(new URL(s.sign('http://h', 'GET', 'screenshots', 'c/a.jpg', exp())).searchParams.get('response-content-disposition'), null);
});
