/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

// Local Supabase API (scripts/local-stack gateway, or `supabase start` on :54321). Proxying keeps the app
// same-origin in development, so VITE_SUPABASE_URL can stay empty.
const api = process.env.SUPABASE_LOCAL_URL ?? 'http://127.0.0.1:54321';
const proxy = Object.fromEntries(['/auth/v1', '/rest/v1', '/storage/v1', '/functions/v1', '/realtime/v1'].map((p) => [p, { target: api, changeOrigin: true, ws: p === '/realtime/v1' }]));

// Fills the service worker's precache list with the built app shell: index.html plus the files it
// loads up front (entry script, preloaded chunks, CSS), the manifest and icons. Lazy route chunks are
// cached the first time they load. The version is a hash of the list's contents, so a deploy that
// changes the shell triggers the in-app update prompt.
function pwaPrecache(): Plugin {
  let outDir = 'dist';
  return {
    name: 'scc-pwa-precache',
    apply: 'build',
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    closeBundle() {
      const sw = path.join(outDir, 'sw.js');
      const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
      const fromHtml = [...html.matchAll(/(?:src|href)="(\/[^"/][^"]*)"/g)].map((m) => m[1]!);
      const statics = ['/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png'];
      const list = ['/', ...new Set([...fromHtml, ...statics])].filter((u) => u === '/' || fs.existsSync(path.join(outDir, u)));
      const hash = createHash('sha256');
      for (const u of list) hash.update(u).update(fs.readFileSync(path.join(outDir, u === '/' ? 'index.html' : u)));
      const src = fs.readFileSync(sw, 'utf8').replace('self.__PRECACHE__', JSON.stringify(list)).replace('__SW_VERSION__', hash.digest('hex').slice(0, 12));
      fs.writeFileSync(sw, src);
    },
  };
}

export default defineConfig({
  plugins: [react(), pwaPrecache()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  // dev server on this machine only; DEV_HOST=0.0.0.0 to test from a phone on the same network
  server: { host: process.env.DEV_HOST ?? 'localhost', proxy },
  preview: { proxy },
  test: { env: { VITE_APP_MODE: 'demo', VITE_DEMO_HINTS: 'false' }, environment: 'jsdom', globals: true, setupFiles: ['src/test/setup.ts'], include: ['src/**/*.test.{ts,tsx}', 'supabase/functions/**/*.test.ts'] },
});
