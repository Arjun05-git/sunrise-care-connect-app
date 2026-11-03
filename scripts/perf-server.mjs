/**
 * Production-like static server for performance measurements: HTTP/2 over TLS (self-signed), gzip for
 * text files and API responses, immutable caching for hashed assets, SPA fallback, and the Supabase paths
 * proxied to the local stack (WebSockets for Realtime included). `vite preview` is HTTP/1.1 without
 * compression, which over-states request and transfer costs compared with a CDN + hosted Supabase.
 *
 *   node scripts/perf-server.mjs <dist dir> [port=4443]      (browsers need --ignore-certificate-errors)
 */
import http2 from 'node:http2';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const DIST = path.resolve(process.argv[2] ?? 'dist');
const PORT = Number(process.argv[3] ?? 4443);
const API = { host: '127.0.0.1', port: Number(process.env.API_PORT ?? 54321) };
const API_PATHS = ['/auth/v1', '/rest/v1', '/storage/v1', '/functions/v1', '/realtime/v1'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const COMPRESS = /^(text\/|application\/(javascript|json|manifest)|image\/svg)/;

const certDir = fs.mkdtempSync(path.join(tmpdir(), 'scc-cert-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost', '-keyout', `${certDir}/k.pem`, '-out', `${certDir}/c.pem`], { stdio: 'ignore' });
const gz = new Map();
const gzipped = (file, buf) => {   // keyed by mtime too, so a rebuild is picked up
  const key = `${file}:${fs.statSync(file).mtimeMs}`;
  return gz.has(key) ? gz.get(key) : gz.set(key, zlib.gzipSync(buf, { level: 9 })).get(key);
};

function serveStatic(req, res, url) {
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
  const buf = fs.readFileSync(file);
  const headers = { 'content-type': type, 'cache-control': url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' };
  if (COMPRESS.test(type) && /gzip/.test(req.headers['accept-encoding'] ?? '')) {
    res.writeHead(200, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' });
    res.end(gzipped(file, buf));
  } else {
    res.writeHead(200, headers);
    res.end(buf);
  }
}

function proxy(req, res) {
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !k.startsWith(':') && k !== 'connection'));
  const up = http.request({ ...API, method: req.method, path: req.url, headers: { ...headers, host: `${API.host}:${API.port}`, 'accept-encoding': 'identity' } }, (r) => {
    const h = Object.fromEntries(Object.entries(r.headers).filter(([k]) => !['connection', 'transfer-encoding', 'keep-alive'].includes(k)));
    const type = String(r.headers['content-type'] ?? '');
    if (COMPRESS.test(type) && /gzip/.test(req.headers['accept-encoding'] ?? '')) {
      res.writeHead(r.statusCode ?? 502, { ...h, 'content-encoding': 'gzip', vary: 'accept-encoding' });
      r.pipe(zlib.createGzip()).pipe(res);
    } else {
      res.writeHead(r.statusCode ?? 502, h);
      r.pipe(res);
    }
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
}

const server = http2.createSecureServer({ key: fs.readFileSync(`${certDir}/k.pem`), cert: fs.readFileSync(`${certDir}/c.pem`), allowHTTP1: true }, (req, res) => {
  const url = new URL(req.url, 'https://localhost');
  if (API_PATHS.some((p) => url.pathname.startsWith(p))) return proxy(req, res);
  serveStatic(req, res, url);
});
// Realtime WebSockets (HTTP/1.1 upgrade) straight through to the gateway
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(API.port, API.host, () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});
server.listen(PORT, () => console.log(`perf server: https://localhost:${PORT} (HTTP/2, gzip) ← ${DIST}`));
