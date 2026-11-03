/**
 * Local API gateway (what Kong + the Edge runtime do in Supabase), for development without Docker:
 *   /auth/v1 → GoTrue · /rest/v1 → PostgREST · /storage/v1 → storage-api   (prefix stripped)
 *   /functions/v1/<name> → supabase/functions/<name>/handler.ts, run in Node with the same Request/Response code
 *   /realtime/v1/websocket → local postgres_changes emulator (realtime.ts)
 *   every minute: run_scheduled_jobs() + refund sweep (what pg_cron does on Supabase)
 * Started by scripts/local-stack/up.sh with the env it needs (keys, payment test secrets).
 */
import http from 'node:http';
import { startRealtime } from './realtime.ts';

const PORT = Number(process.env.GATEWAY_PORT ?? 54321);
const upstream: Record<string, number> = { auth: 9999, rest: 3000, storage: 5000 };
const FUNCTIONS = ['payments-create-order', 'payments-verify', 'payments-webhook', 'payments-mock-checkout', 'payments-refund', 'payments-receipt', 'video-token', 'video-webhook', 'prescription-pdf', 'prescription-verify', 'doctor-signature', 'notifications-dispatch', 'notifications-webhook', 'admin-users', 'integrations-dispatch', 'abha', 'documents-register', 'auth-sms-hook'];
const loaded = new Map<string, (req: Request) => Promise<Response>>();

async function fn(name: string) {
  if (!loaded.has(name)) loaded.set(name, (await import(`../../supabase/functions/${name}/handler.ts`)).default);
  return loaded.get(name)!;
}

const readBody = (req: http.IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const realtime = startRealtime({ databaseUrl: process.env.DATABASE_URL!, jwtSecret: process.env.LOCAL_JWT_SECRET! });

const server = http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    const [, service, version, ...rest] = url.pathname.split('/');
    try {
      if (service === 'functions' && version === 'v1' && FUNCTIONS.includes(rest[0] ?? '')) {
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
        const out = await (await fn(rest[0]!))(new Request(url, { method: req.method, headers, body }));
        res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
        res.end(Buffer.from(await out.arrayBuffer()));
        return;
      }
      const port = upstream[service ?? ''];
      if (!port || version !== 'v1') {
        res.writeHead(404).end('not_found');
        return;
      }
      const p = http.request(
        { host: '127.0.0.1', port, method: req.method, path: '/' + rest.join('/') + url.search, headers: { ...req.headers, host: `127.0.0.1:${port}` }, agent: false }, // no pooled sockets: an idle upstream close would surface as a 502
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      p.on('error', () => res.writeHead(502).end('bad_gateway'));
      req.pipe(p);
    } catch (e) {
      console.error('gateway_error', (e as Error).message);
      if (!res.headersSent) res.writeHead(500).end('internal_error');
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`gateway on :${PORT}`));

server.on('upgrade', (req, socket, head) => {
  if ((req.url ?? '').startsWith('/realtime/v1/websocket')) realtime.handleUpgrade(req, socket, head);
  else socket.destroy();
});

// pg_cron stand-in: scheduled jobs, then send any queued refunds to the gateway
setInterval(async () => {
  try {
    await realtime.pool.query('select public.run_scheduled_jobs()');
    const sweep = await fn('payments-refund');
    await sweep(new Request(`http://127.0.0.1:${PORT}/functions/v1/payments-refund`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` }, body: '{"sweep":true}',
    }));
  } catch (e) {
    console.error('scheduler_error', (e as Error).message);
  }
}, Number(process.env.SCHEDULER_MS ?? 60_000));

// notification dispatcher (Supabase: pg_cron → pg_net → notifications-dispatch every minute; locally more often)
let dispatching = false;
setInterval(async () => {
  if (dispatching) return;
  dispatching = true;
  try {
    const send = await fn('notifications-dispatch');
    await send(new Request(`http://127.0.0.1:${PORT}/functions/v1/notifications-dispatch`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` }, body: '{}',
    }));
  } catch (e) {
    console.error('dispatch_error', (e as Error).message);
  } finally {
    dispatching = false;
  }
}, Number(process.env.DISPATCH_MS ?? 5_000));

// integrations dispatcher (Supabase: pg_cron → pg_net every minute; locally more often) and the nightly
// HIS doctor-master pull (locally: shortly after start, then every 24 h)
const service = (name: string, body: unknown) => fn(name).then((f) => f(new Request(`http://127.0.0.1:${PORT}/functions/v1/${name}`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` }, body: JSON.stringify(body),
})));
let integrating = false;
setInterval(async () => {
  if (integrating) return;
  integrating = true;
  try {
    await service('integrations-dispatch', {});
  } catch (e) {
    console.error('integrations_error', (e as Error).message);
  } finally {
    integrating = false;
  }
}, Number(process.env.INTEGRATIONS_MS ?? 10_000));
const doctorMaster = () => service('integrations-dispatch', { job: 'doctor_master' }).catch((e) => console.error('doctor_master_error', (e as Error).message));
setTimeout(doctorMaster, 20_000);
setInterval(doctorMaster, 24 * 3600_000);

