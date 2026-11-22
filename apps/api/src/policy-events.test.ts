import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError } from './core';
import { frame, PolicyEvents, StreamOwner } from './policy-events';
import type { Policy } from './policy';

class Sink extends EventEmitter {
  head?: Record<string, string>;
  socket = { destroyed: false };
  chunks: string[] = [];
  ended = false;
  writeHead(_status: number, h: Record<string, string>) { this.head = h; return this; }
  write(c: string) { this.chunks.push(c); return true; }
  end() { this.ended = true; this.emit('close'); return this; }
  get policies() { return this.chunks.filter((c) => c.startsWith('event: policy')); }
}

const owner = (device: string, employee = 'e1', company = 'c1'): StreamOwner =>
  ({ device_id: device, company_id: company, employee_id: employee, key_hash: 'h-' + device, base: 'http://h' });
const policy = (v: number): Policy => ({ body: `{"data":{"policy_version":${v}}}`, etag: `"e${v}"` });
const opts = { spreadMs: 20, keepaliveMs: 15, relistenMs: 0, random: () => 1 };

function setup(load: (o: StreamOwner) => Promise<Policy>) {
  const events = new PolicyEvents(load, opts);
  const open = (o: StreamOwner, p = policy(1)) => { const s = new Sink(); events.open(s as any, o, p); return s; };
  return { events, open };
}

test('a policy event is one line of JSON carrying the ETag and the policy body', () => {
  const f = frame(policy(7));
  assert.equal(f, 'event: policy\ndata: {"etag":"\\"e7\\"","data":{"policy_version":7}}\n\n');
  const data = JSON.parse(f.split('\n')[1].slice('data: '.length));
  assert.deepEqual(data, { etag: '"e7"', data: { policy_version: 7 } });
});

test('the stream opens with its headers and the current policy, then keeps alive', async () => {
  const { events, open } = setup(async () => policy(1));
  const s = open(owner('d1'));
  assert.equal(s.head?.['Content-Type'], 'text/event-stream');
  assert.equal(s.head?.['X-Accel-Buffering'], 'no');
  assert.equal(s.policies.length, 1);
  await sleep(40);
  assert.ok(s.chunks.filter((c) => c === ': ping\n\n').length >= 2);
  s.emit('close');
  assert.equal(events.size, 0);
});

test('a change reaches only the streams it concerns, once each, after the spread', async () => {
  let loads = 0;
  const { events, open } = setup(async () => { loads++; return policy(2); });
  const a = open(owner('d1', 'e1')), b = open(owner('d2', 'e2')), other = open(owner('d3', 'e3', 'c2'));
  events.notify('c:c1');
  events.notify('c:c1'); // a second change while a push waits: still one push per stream
  assert.equal(a.policies.length, 1, 'nothing before the random delay');
  await sleep(40);
  assert.equal(loads, 2);
  assert.equal(a.policies.length, 2);
  assert.equal(b.policies.length, 2);
  assert.equal(other.policies.length, 1);
  events.notify('e:e2');
  await sleep(40);
  assert.equal(b.policies.length, 2, 'the same ETag is not sent again');
  for (const s of [a, b, other]) s.emit('close');
});

test('a client gone before the stream opens is not held', () => {
  const events = new PolicyEvents(async () => policy(1), opts);
  const s = new Sink();
  s.socket.destroyed = true;
  events.open(s as any, owner('d1'), policy(1));
  assert.equal(events.size, 0);
  assert.ok(s.ended);
  assert.equal(s.policies.length, 0);
});

test('a second stream for the device closes the first', () => {
  const { events, open } = setup(async () => policy(1));
  const first = open(owner('d1')), second = open(owner('d1'));
  assert.ok(first.ended);
  assert.ok(!second.ended);
  assert.equal(events.size, 1);
  second.emit('close');
});

test('a push that would answer 401 or 402 closes the stream; another failure keeps it', async () => {
  let fail: Error = new Error('db down');
  const { events, open } = setup(async () => { throw fail; });
  const s = open(owner('d1'));
  events.notify('d:d1');
  await sleep(40);
  assert.ok(!s.ended);
  fail = new ApiError(401, 'DEVICE_RELEASED', 'Device released');
  events.notify('d:d1');
  await sleep(40);
  assert.ok(s.ended);
  assert.equal(events.size, 0);
});
