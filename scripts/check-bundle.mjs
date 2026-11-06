#!/usr/bin/env node
// Proves a PRODUCTION build carries no demo code and no secrets: builds with VITE_APP_ENV=production into a temp folder
// and fails if any demo credential or demo account, or any secret token (service-role key, private key, live payment
// key …), shows up in the output. Run it in CI and before every release:
//   npm run check:bundle
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanText } from './lib/secret-patterns.mjs';

// Strings that exist only in demo code (src/auth/demoAuth.ts, src/data/seed). Add more as demo features grow.
const MARKERS = ['Sunrise@123', 'admin@sunrise.demo', 'coordinator@sunrise.demo', 'finance@sunrise.demo', '+919847000001', '+919847100001', 'u-patient-1', 'u-doctor-1'];

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-prod-bundle-'));
const env = { ...process.env, VITE_APP_ENV: 'production', VITE_APP_MODE: 'supabase', VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_ANON_KEY: process.env.CHECK_BUNDLE_ANON_KEY ?? 'bundle-check', VITE_DEMO_HINTS: 'false' };
const build = spawnSync('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { env, stdio: 'inherit', shell: process.platform === 'win32' });
if (build.status !== 0) {
  console.error('Production build failed – cannot check the bundle.');
  process.exit(1);
}

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|css|html|json|webmanifest)$/.test(e.name)) files.push(p);
  }
})(out);

const hits = [];
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  for (const m of MARKERS) if (text.includes(m)) hits.push(`${path.relative(out, f)}: ${m}`);
  for (const s of scanText(text, f, { bundle: true })) hits.push(`${path.relative(out, f)}: SECRET ${s.rule} ${s.preview}`);
}
fs.rmSync(out, { recursive: true, force: true });

if (hits.length) {
  console.error(`Production bundle contains demo data or secrets:\n  - ${hits.join('\n  - ')}`);
  process.exit(1);
}
console.log(`✓ production bundle clean (${files.length} files checked, ${MARKERS.length} demo markers and all secret patterns absent)`);
