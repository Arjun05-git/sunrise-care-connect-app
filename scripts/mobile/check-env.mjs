#!/usr/bin/env node
// Guards `npm run mobile:build`: the app inside Android/iOS runs at https://localhost, so it can't use
// the same-origin API fallback the website uses. Reads .env.mobile (vite --mode mobile) and the shell env.
import fs from 'node:fs';

const file = fs.existsSync('.env.mobile') ? fs.readFileSync('.env.mobile', 'utf8') : '';
const env = { ...Object.fromEntries(file.split('\n').map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^['"]|['"]$/g, '')])), ...process.env };
const problems = [];
if (env.VITE_APP_MODE !== 'supabase') problems.push('VITE_APP_MODE must be "supabase"');
if (!/^https:\/\//.test(env.VITE_SUPABASE_URL ?? '')) problems.push('VITE_SUPABASE_URL must be the https URL of the Supabase project');
if (!env.VITE_SUPABASE_ANON_KEY) problems.push('VITE_SUPABASE_ANON_KEY is required');
if (env.VITE_DEMO_HINTS === 'true') problems.push('VITE_DEMO_HINTS must not be true in a store build');
for (const k of Object.keys(env)) if (k.startsWith('VITE_') && /SECRET|SERVICE_ROLE|PRIVATE/.test(k)) problems.push(`${k} looks like a secret; VITE_ variables are shipped inside the app`);
if (problems.length) {
  console.error(`Mobile build stopped (see .env.mobile.example):\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
