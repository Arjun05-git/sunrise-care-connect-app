/**
 * PWA end to end, against a production build served by `vite preview` (the service worker only registers
 * in production):
 *   manifest + icons are valid · the worker installs and precaches only the app shell · after using the app,
 *   no API/auth/storage/function response is in any cache · offline, a deep link still opens the shell with
 *   the offline banner · a new deploy shows the update prompt → Reload → the new worker takes over ·
 *   iPhone Safari shows the "Add to Home Screen" hint · phone widths.
 *
 *   npm run stack:up
 *   VITE_APP_ENV=demo VITE_APP_MODE=supabase npx vite build --outDir /tmp/pwa-dist && npx vite preview --outDir /tmp/pwa-dist --port 4175
 *   DIST=/tmp/pwa-dist node scripts/e2e-pwa.mjs http://localhost:4175
 */
import { chromium } from 'playwright-core';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:4175';
const OUT = process.argv[3] ?? 'docs/screenshots';
const DIST = process.env.DIST;
if (!DIST) throw new Error('DIST must point at the served build folder');
mkdirSync(OUT, { recursive: true });
const ok = (s) => console.log('✓', s);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const errors = [];
const pages = [];
const swPath = path.join(DIST, 'sw.js');
const swOriginal = readFileSync(swPath, 'utf8');
process.on('uncaughtException', async (e) => {
  console.error('✗', e.message.split('\n')[0]);
  writeFileSync(swPath, swOriginal);
  for (const [i, pg] of pages.entries()) await pg.screenshot({ path: `${OUT}/fail-pwa-${i}.png`, fullPage: true }).catch(() => {});
  if (errors.length) console.error('console errors:\n' + [...new Set(errors)].join('\n'));
  process.exit(1);
});
async function newContext(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ...opts });
  const page = await ctx.newPage();
  pages.push(page);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|fonts\.g|WebSocket|ERR_INTERNET_DISCONNECTED|Failed to fetch|NetworkError/.test(m.text()) && errors.push(m.text()));
  return { ctx, page };
}
async function shot(page, name) {
  const [sw, w] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  if (sw > w) throw new Error(`${name}: horizontal overflow (${sw}px > ${w}px)`);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}
async function otpLogin(page, phone) {
  await page.goto(`${BASE}/login`);
  const form = page.getByRole('tabpanel');
  await form.getByLabel('Mobile number').fill(phone);
  await form.getByRole('button', { name: 'Get OTP' }).click();
  await page.getByLabel('One-time password digit 1').fill('123456');
  await page.getByRole('button', { name: 'Verify & continue' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}
const cachedUrls = (page) => page.evaluate(async () => {
  const out = [];
  for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(`${k} ${new URL(r.url).pathname}${new URL(r.url).host.includes('fonts') ? ' (font)' : ''}`);
  return out;
});

// ---------------------------------------------------------------- 1. manifest + icons
const { ctx, page: p } = await newContext();
const res = await p.goto(`${BASE}/manifest.webmanifest`);
const manifest = await res.json();
for (const k of ['name', 'short_name', 'start_url', 'display', 'theme_color', 'background_color']) if (!manifest[k]) throw new Error(`manifest.${k} missing`);
if (manifest.display !== 'standalone') throw new Error('manifest display');
const sizes = [];
for (const icon of manifest.icons) {
  const r = await p.goto(`${BASE}${icon.src}`);
  if (r.status() !== 200) throw new Error(`icon ${icon.src}: ${r.status()}`);
  if (icon.type === 'image/png') {
    const [w, h] = await p.evaluate(() => [document.images[0]?.naturalWidth, document.images[0]?.naturalHeight]);
    if (`${w}x${h}` !== icon.sizes) throw new Error(`icon ${icon.src} is ${w}x${h}, manifest says ${icon.sizes}`);
    sizes.push(`${icon.sizes}${icon.purpose === 'maskable' ? ' maskable' : ''}`);
  }
}
if (!sizes.includes('192x192') || !sizes.includes('512x512') || !sizes.includes('512x512 maskable')) throw new Error(`icons: ${sizes}`);
ok(`manifest: standalone, theme ${manifest.theme_color}, icons ${sizes.join(', ')}, ${manifest.shortcuts.length} shortcuts`);

// ---------------------------------------------------------------- 2. worker installs, precaches the shell
await otpLogin(p, '9847000001');
await p.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.active, null, { timeout: 20000 });
await p.reload();
await p.waitForFunction(() => !!navigator.serviceWorker.controller);
const precached = (await cachedUrls(p)).filter((u) => u.startsWith('scc-shell-'));
if (!precached.some((u) => u.endsWith(' /')) || !precached.some((u) => /\/assets\/index-.*\.js$/.test(u))) throw new Error(`precache: ${precached.join(', ')}`);
ok(`service worker active and controlling; shell precached (${precached.length} files)`);

// use the app: home, appointments, records, profile → API traffic must never be cached
for (const route of ['/p', '/p/appointments', '/p/records', '/p/profile']) {
  await p.goto(`${BASE}${route}`);
  await p.getByRole('heading', { level: 1 }).first().waitFor();
}
const all = await cachedUrls(p);
const leaked = all.filter((u) => /\/(rest|auth|storage|functions|realtime)\/v1/.test(u));
if (leaked.length) throw new Error(`API responses cached: ${leaked.join(', ')}`);
if (all.some((u) => !/^scc-(shell|assets)-\w+ \/(assets\/|icons\/|favicon|manifest|$)|^scc-fonts /.test(u))) throw new Error(`unexpected cache entries: ${all.join(', ')}`);
ok(`after using the app: ${all.length} cache entries, all shell files or fonts – no API, auth, storage or function responses`);

// ---------------------------------------------------------------- 3. offline deep link → shell + banner
await ctx.setOffline(true);
await p.goto(`${BASE}/p/appointments`);
await p.locator('[data-ref="offline-banner"]').waitFor();
await p.getByText('You’re offline', { exact: false }).or(p.getByText("You're offline", { exact: false })).first().waitFor();
await p.waitForTimeout(1500);
if (await p.getByLabel('Mobile number').count()) throw new Error('signed-in user sent to the login screen while offline');
if (!p.url().endsWith('/p/appointments')) throw new Error(`offline deep link moved to ${p.url()}`);
await shot(p, 'pwa-offline-mobile');
ok('offline: a deep link still opens the app shell with the offline banner; the user stays signed in');
await ctx.setOffline(false);
await p.evaluate(() => window.dispatchEvent(new Event('online')));
await p.locator('[data-ref="offline-banner"]').waitFor({ state: 'detached' });
await p.getByRole('heading', { name: 'Appointments' }).first().waitFor();
ok('back online: the banner goes away and the page loads');

// ---------------------------------------------------------------- 4. new deploy → update prompt → reload
await p.goto(`${BASE}/p`);
await p.getByRole('heading', { level: 1 }).first().waitFor();
const before = await p.evaluate(() => navigator.serviceWorker.controller?.scriptURL && caches.keys());
appendFileSync(swPath, `\n// e2e deploy ${Date.now()}\n`);
await p.evaluate(async () => (await navigator.serviceWorker.getRegistration('/'))?.update());
await p.getByText('A new version of Sunrise Care is ready.').waitFor({ timeout: 20000 });
await shot(p, 'pwa-update-mobile');
await Promise.all([p.waitForEvent('load'), p.getByRole('button', { name: 'Reload' }).click()]);
await p.waitForFunction(async () => {
  const r = await navigator.serviceWorker.getRegistration('/');
  return !!r?.active && !r.waiting && !!navigator.serviceWorker.controller;
});
writeFileSync(swPath, swOriginal);
ok(`new deploy → "A new version is ready" → Reload → the new worker controls the page (caches before: ${before.length})`);

// ---------------------------------------------------------------- 5. iPhone Safari → Add to Home Screen hint
const iphone = await newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', viewport: { width: 375, height: 812 } });
await otpLogin(iphone.page, '9847000001');
await iphone.page.goto(`${BASE}/p/profile`);
const install = iphone.page.locator('[data-ref="install-card"]');
await install.getByText('Add to Home Screen', { exact: false }).waitFor();
await install.scrollIntoViewIfNeeded();
await shot(iphone.page, 'pwa-install-ios-mobile');
ok('iPhone Safari: profile shows the Share → "Add to Home Screen" hint');

if (errors.length) throw new Error('console errors:\n' + [...new Set(errors)].join('\n'));
await browser.close();
console.log('\nPWA e2e: all checks passed');
