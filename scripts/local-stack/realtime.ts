/**
 * Minimal Supabase Realtime (postgres_changes) for local development without Docker.
 * Speaks the Phoenix channel protocol @supabase/realtime-js uses – vsn 1.0.0 (JSON objects) and 2.0.0
 * (JSON arrays [join_ref, ref, topic, event, payload], the default since realtime-js 2.1x) – so app code is
 * identical against real Supabase. Changes come from pg_notify (scripts/local-stack/realtime.sql);
 * before delivering a row it is re-read AS THE SUBSCRIBER (JWT claims + role authenticated), so RLS
 * decides who receives what – like Supabase Realtime. Supports event filters and `col=eq.value`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import pg from 'pg';
import { WebSocketServer, type WebSocket } from 'ws';

interface Binding { id: number; event: string; schema: string; table: string; filter?: string }
interface Topic { joinRef: string | null; bindings: Binding[]; claims: Record<string, unknown> | null }
interface Msg { topic: string; event: string; payload: Record<string, unknown>; ref: string | null; join_ref?: string | null }
interface Change { table: string; type: 'INSERT' | 'UPDATE' | 'DELETE'; record: Record<string, unknown> | null; old_record: Record<string, unknown> | null }

const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function verifyJwt(token: string, secret: string): Record<string, unknown> | null {
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) return null;
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const given = b64url(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const claims = JSON.parse(b64url(p).toString()) as Record<string, unknown>;
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return null;
  return claims;
}

export function startRealtime(opts: { databaseUrl: string; jwtSecret: string }) {
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Map<WebSocket, Map<string, Topic>>();
  const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 4 });
  let nextId = 1;

  // vsn per socket, from the ?vsn= query the client connects with
  const v2 = new WeakSet<WebSocket>();
  const send = (ws: WebSocket, m: Msg) =>
    ws.readyState === ws.OPEN && ws.send(JSON.stringify(v2.has(ws) ? [m.join_ref ?? null, m.ref ?? null, m.topic, m.event, m.payload] : m));
  const reply = (ws: WebSocket, m: Msg, response: Record<string, unknown> = {}, status = 'ok') =>
    send(ws, { topic: m.topic, event: 'phx_reply', payload: { status, response }, ref: m.ref, join_ref: m.join_ref ?? null });

  wss.on('connection', (ws, req) => {
    const topics = new Map<string, Topic>();
    sockets.set(ws, topics);
    const query = new URL(req.url ?? '/', 'http://x').searchParams;
    const apikey = query.get('apikey') ?? '';
    if (query.get('vsn') === '2.0.0') v2.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.on('message', (raw) => {
      let m: Msg;
      try {
        const parsed = JSON.parse(String(raw)) as Msg | [string | null, string | null, string, string, Record<string, unknown>];
        m = Array.isArray(parsed) ? { join_ref: parsed[0], ref: parsed[1], topic: parsed[2], event: parsed[3], payload: parsed[4] ?? {} } : parsed;
      } catch {
        return;
      }
      if (m.topic === 'phoenix' && m.event === 'heartbeat') return reply(ws, m);
      if (m.event === 'phx_join') {
        const token = (m.payload.access_token as string | undefined) ?? apikey;
        const claims = verifyJwt(token, opts.jwtSecret);
        if (!claims) return reply(ws, m, { reason: 'invalid_token' }, 'error');
        const cfg = (m.payload.config ?? {}) as { postgres_changes?: Omit<Binding, 'id'>[] };
        const bindings = (cfg.postgres_changes ?? []).map((b) => ({ ...b, id: nextId++ }));
        topics.set(m.topic, { joinRef: m.join_ref ?? m.ref, bindings, claims });
        reply(ws, m, { postgres_changes: bindings });
        send(ws, { topic: m.topic, event: 'system', payload: { status: 'ok', message: 'Subscribed to PostgreSQL', extension: 'postgres_changes', channel: m.topic.replace(/^realtime:/, '') }, ref: null });
        return;
      }
      if (m.event === 'access_token') {
        const t = topics.get(m.topic);
        const claims = verifyJwt(String(m.payload.access_token ?? ''), opts.jwtSecret);
        if (t && claims) t.claims = claims;
        return;
      }
      if (m.event === 'phx_leave') {
        topics.delete(m.topic);
        return reply(ws, m);
      }
      reply(ws, m); // broadcast / presence: accepted, not emulated
    });
  });

  const matches = (b: Binding, c: Change) => {
    if (b.schema !== 'public' || b.table !== c.table) return false;
    if (b.event !== '*' && b.event.toUpperCase() !== c.type) return false;
    if (!b.filter) return true;
    const f = /^(\w+)=eq\.(.+)$/.exec(b.filter);
    const row = c.record ?? c.old_record ?? {};
    return !!f && String(row[f[1]!]) === f[2];
  };

  /** RLS check: can this subscriber SELECT the row? */
  async function visible(claims: Record<string, unknown>, table: string, id: unknown): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify(claims), String(claims.sub ?? '')]);
      await client.query(`set local role ${claims.role === 'authenticated' ? 'authenticated' : 'anon'}`);
      const r = await client.query(`select 1 from public.${pg.escapeIdentifier(table)} where id = $1`, [id]);
      return (r.rowCount ?? 0) > 0;
    } catch {
      return false;
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  }

  async function deliver(c: Change) {
    for (const [ws, topics] of sockets) {
      for (const [topic, t] of topics) {
        const ids = t.bindings.filter((b) => matches(b, c)).map((b) => b.id);
        if (!ids.length || !t.claims) continue;
        if (c.type !== 'DELETE' && !(await visible(t.claims, c.table, c.record?.id))) continue;
        send(ws, {
          topic, event: 'postgres_changes', ref: null,
          payload: { ids, data: { schema: 'public', table: c.table, commit_timestamp: new Date().toISOString(), type: c.type, columns: [], record: c.record ?? {}, old_record: c.old_record ?? {}, errors: null } },
        });
      }
    }
  }

  const listener = new pg.Client({ connectionString: opts.databaseUrl });
  void listener.connect().then(() => listener.query('listen scc_realtime'));
  listener.on('notification', (n) => {
    try {
      void deliver(JSON.parse(n.payload ?? '{}') as Change);
    } catch {
      /* ignore malformed */
    }
  });

  return {
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    },
    pool,
  };
}
