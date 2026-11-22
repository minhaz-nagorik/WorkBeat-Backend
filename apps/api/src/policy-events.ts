// Policy pushed to connected agents (agent-policy-events, B32). One LISTEN connection per instance
// hears which company, employee or device changed (0014); each affected open stream gets the fresh
// policy after its own random 0–5 s delay, so a company-wide change never lands as one burst.
import type { ServerResponse } from 'node:http';
import { Client } from 'pg';
import { ApiError, Db } from './core';
import { authDeviceHash } from './device';
import { buildPolicy, Policy } from './policy';
import { Storage } from './storage';

export const EVENTS = { spreadMs: 5_000, keepaliveMs: 25_000, relistenMs: 5_000 };

export type StreamOwner = { device_id: string; company_id: string; employee_id: string; key_hash: string; base: string };
// Throws the route's ApiError (401, 402) when the device may no longer have its policy.
export type PolicyLoader = (owner: StreamOwner) => Promise<Policy>;
type Sink = Pick<ServerResponse, 'writeHead' | 'write' | 'end' | 'on'> & { socket?: { destroyed: boolean } | null };

type Stream = { owner: StreamOwner; sink: Sink; etag: string; pending?: NodeJS.Timeout; keepalive: NodeJS.Timeout; closed: boolean; opened: number };

// One line of JSON: { "etag", "data" } where data is the GET /v1/agents/policy body's data.
export const frame = (p: Policy) => `event: policy\ndata: {"etag":${JSON.stringify(p.etag)},${p.body.slice(1)}\n\n`;

export class PolicyEvents {
  private byDevice = new Map<string, Stream>();
  private byTopic = new Map<string, Set<Stream>>(); // c:<company>, e:<employee>, d:<device>

  constructor(private load: PolicyLoader, private opts = { ...EVENTS, random: Math.random }) {}

  static forDb(db: Db, storage: Storage): PolicyEvents {
    return new PolicyEvents((o) => db.tx(async (c) => {
      const { dev, billing } = await authDeviceHash(c, o.key_hash, 'normal');
      if (billing) throw billing;
      return buildPolicy(c, dev, storage, o.base);
    }, { snapshot: true }));
  }

  get size() { return this.byDevice.size; }

  // Takes over a hijacked reply: headers, the current policy, then keepalives. A device's newer
  // stream closes its older one.
  open(sink: Sink, owner: StreamOwner, policy: Policy) {
    // Gone while it was authenticated: its 'close' has already fired and would never free the stream.
    if (!sink.socket || sink.socket.destroyed) return void sink.end();
    const old = this.byDevice.get(owner.device_id);
    if (old) this.close(old, 'replaced');
    sink.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    sink.write(frame(policy));
    const s: Stream = { owner, sink, etag: policy.etag, closed: false, opened: Date.now(),
      keepalive: setInterval(() => sink.write(': ping\n\n'), this.opts.keepaliveMs) };
    this.byDevice.set(owner.device_id, s);
    for (const t of topics(owner)) (this.byTopic.get(t) ?? this.byTopic.set(t, new Set()).get(t)!).add(s);
    sink.on('close', () => this.close(s, 'disconnected'));
  }

  // A NOTIFY payload. Each stream holds at most one waiting push; a change during it is in its load.
  notify(topic: string) {
    for (const s of this.byTopic.get(topic) ?? []) {
      if (s.pending) continue;
      s.pending = setTimeout(() => { s.pending = undefined; void this.push(s); }, this.opts.random() * this.opts.spreadMs);
    }
  }

  private async push(s: Stream) {
    try {
      const policy = await this.load(s.owner);
      if (s.closed || policy.etag === s.etag) return;
      s.etag = policy.etag;
      s.sink.write(frame(policy));
    } catch (e) {
      // Released, revoked or suspended: close; the agent's reopen is answered with the status.
      if (e instanceof ApiError && (e.status === 401 || e.status === 402)) return this.close(s, e.code);
      // Anything else: keep the stream; the agent's poll still catches the change.
      console.error(JSON.stringify({ t: new Date(), level: 'error', msg: 'policy_push_failed', err: (e as Error)?.name, device_id: s.owner.device_id }));
    }
  }

  private close(s: Stream, reason: string) {
    if (s.closed) return;
    s.closed = true;
    clearInterval(s.keepalive);
    clearTimeout(s.pending);
    if (this.byDevice.get(s.owner.device_id) === s) this.byDevice.delete(s.owner.device_id);
    for (const t of topics(s.owner)) {
      const set = this.byTopic.get(t);
      set?.delete(s);
      if (set?.size === 0) this.byTopic.delete(t);
    }
    s.sink.end();
    // One line per stream, as onResponse does not run for a hijacked reply; never the key (api-logging).
    console.log(JSON.stringify({ t: new Date(), route: '/v1/agents/events', status: 200, code: reason,
      ms: Date.now() - s.opened, scope: 'tenant', company_id: s.owner.company_id, device_id: s.owner.device_id }));
  }

  // shortcut: notifications missed while LISTEN reconnects are not replayed; the agents' heartbeat
  // version check (5 min) and poll (30 min) catch them. Replay to every stream if that proves too slow.
  listen(url: string) {
    const retry = () => setTimeout(() => this.listen(url), this.opts.relistenMs);
    const c = new Client({ connectionString: url });
    let retried = false;
    const fail = (e?: Error) => {
      if (retried) return;
      retried = true;
      console.error(JSON.stringify({ t: new Date(), level: 'error', msg: 'policy_listen_lost', err: e?.name, pg_code: (e as { code?: string })?.code }));
      void c.end().catch(() => {});
      retry();
    };
    c.on('notification', (n) => { if (n.payload) this.notify(n.payload); });
    c.on('error', fail);
    c.on('end', () => fail());
    c.connect().then(() => c.query('LISTEN policy_events')).catch(fail);
  }
}

const topics = (o: StreamOwner) => [`c:${o.company_id}`, `e:${o.employee_id}`, `d:${o.device_id}`];
