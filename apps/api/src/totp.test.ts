import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base32Decode, base32Encode, totpAt, verifyTotp } from './totp';

// RFC 6238 appendix B, SHA-1 seed "12345678901234567890".
const RFC = base32Encode(Buffer.from('12345678901234567890'));

test('base32 round-trips', () => {
  assert.equal(RFC, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(base32Decode(RFC).toString(), '12345678901234567890');
});

test('RFC 6238 vectors (8 digits)', () => {
  for (const [t, code] of [[59, '94287082'], [1111111109, '07081804'], [1234567890, '89005924'], [20000000000, '65353130']] as const)
    assert.equal(totpAt(RFC, Math.floor(t / 30), 8), code);
});

test('verify accepts ±1 step, rejects reuse and garbage', () => {
  const now = 1234567890 * 1000, step = Math.floor(1234567890 / 30);
  assert.equal(verifyTotp(RFC, totpAt(RFC, step), null, now), step);
  assert.equal(verifyTotp(RFC, totpAt(RFC, step - 1), null, now), step - 1);
  assert.equal(verifyTotp(RFC, totpAt(RFC, step - 2), null, now), null);
  assert.equal(verifyTotp(RFC, totpAt(RFC, step), step, now), null); // replay
  assert.equal(verifyTotp(RFC, '12ab56', null, now), null);
});
