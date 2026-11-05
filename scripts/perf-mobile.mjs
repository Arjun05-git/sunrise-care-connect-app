/**
 * Mobile performance on a throttled 4G connection: Lighthouse (performance category) against a production
 * build, phone form factor, Lighthouse's "Slow 4G" profile APPLIED by DevTools (real throttling, not
 * simulated): ~1.47 Mbps down / 675 kbps up, 562 ms request latency (= 150 ms RTT), CPU slowed 4×.
 * Cold load every run: HTTP cache, service worker and Cache Storage cleared; the sign-in (localStorage)
 * is kept for signed-in pages. Median of N runs per page.
 *
 *   VITE_APP_ENV=demo VITE_APP_MODE=supabase npx vite build --outDir /tmp/perf-dist && npx vite preview --outDir /tmp/perf-dist --port 4176
 *   node scripts/perf-mobile.mjs http://localhost:4176 [runs=3] [report.json]
 */
import { chromium } from 'playwright-core';
import lighthouse from 'lighthouse';
import * as constants from 'lighthouse/core/config/constants.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE = process.argv[2] ?? 'http://localhost:4176';
const RUNS = Number(process.argv[3] ?? 3);
const REPORT = process.argv[4] ?? 'perf-report.json';
const PORT = 9333;
const DB = process.env.STACK_DB ?? 'sunrise_local';
const sql = (q) => { try { return execFileSync('psql', ['-X', '-At', '-q', '-d', DB, '-c', q], { encoding: 'utf8' }).trim(); } catch { return ''; } };

const config = {
  extends: 'lighthouse:default',
  settings: {
    onlyCategories: ['performance'],
    formFactor: 'mobile',
    screenEmulation: constants.screenEmulationMetrics.mobile,
    emulatedUserAgent: constants.userAgents.mobile,
    throttlingMethod: 'devtools',
    throttling: constants.throttling.mobileSlow4G,
    disableStorageReset: true,   // keep the sign-in; caches are cleared by hand below
    maxWaitForLoad: 60_000,
  },
};

const userDir = mkdtempSync(path.join(tmpdir(), 'scc-perf-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: [`--remote-debugging-port=${PORT}`, '--ignore-certificate-errors'],   // perf-server.mjs uses a self-signed cert
  viewport: { width: 412, height: 823 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const cdp = await ctx.newCDPSession(page);

async function coldStart() {
  await page.goto(`${BASE}/login`);
  await page.evaluate(async () => {
    for (const r of (await navigator.serviceWorker?.getRegistrations?.()) ?? []) await r.unregister();
    for (const k of (await caches?.keys?.()) ?? []) await caches.delete(k);
  });
  await cdp.send('Network.clearBrowserCache');
  await page.goto('about:blank');
}
async function login(phone) {
  await page.goto(`${BASE}/login`);
  if (phone.startsWith('98471')) await page.getByRole('tab', { name: 'Doctor' }).click();
  const form = page.getByRole('tabpanel');
  await form.getByLabel('Mobile number').fill(phone);
  await form.getByRole('button', { name: 'Get OTP' }).click();
  await page.getByLabel('One-time password digit 1').fill('123456');
  await page.getByRole('button', { name: 'Verify & continue' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}
async function logout() {
  await page.goto(`${BASE}/login`);
  await page.evaluate(() => localStorage.removeItem('scc-auth'));
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const results = [];
const ONLY = process.env.PAGES ? process.env.PAGES.split(',') : null;
async function measure(name, url) {
  if (ONLY && !ONLY.some((o) => name.includes(o))) return;
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    await coldStart();
    const r = await lighthouse(url, { port: PORT, output: 'json', logLevel: 'error' }, config);
    const a = r.lhr.audits;
    runs.push({
      score: Math.round(r.lhr.categories.performance.score * 100),
      fcp: a['first-contentful-paint'].numericValue, lcp: a['largest-contentful-paint'].numericValue,
      tbt: a['total-blocking-time'].numericValue, cls: a['cumulative-layout-shift'].numericValue,
      si: a['speed-index'].numericValue, tti: a.interactive?.numericValue ?? 0,
      kb: Math.round(a['total-byte-weight'].numericValue / 1024),
      requests: a['network-requests']?.details?.items?.length ?? 0,
      js: Math.round((a['resource-summary']?.details?.items?.find((x) => x.resourceType === 'script')?.transferSize ?? 0) / 1024),
      opportunities: Object.values(a).filter((x) => x.details?.type === 'opportunity' && (x.details.overallSavingsMs ?? 0) > 100)
        .map((x) => `${x.id} ~${Math.round(x.details.overallSavingsMs)}ms`),
      finalUrl: r.lhr.finalDisplayedUrl,
      // what to fix: the LCP element, what moved, what blocked the first paint
      lcpElement: a['largest-contentful-paint-element']?.details?.items?.[0]?.items?.[0]?.node?.snippet?.slice(0, 160),
      shifts: (a['layout-shifts']?.details?.items ?? []).slice(0, 5).map((x) => `${(x.score ?? 0).toFixed(3)} ${x.node?.snippet?.slice(0, 120) ?? ''}`),
      renderBlocking: (a['render-blocking-resources']?.details?.items ?? []).map((x) => `${x.url.replace(BASE, '')} ${Math.round(x.wastedMs)}ms`),
    });
  }
  const m = Object.fromEntries(['score', 'fcp', 'lcp', 'tbt', 'cls', 'si', 'tti', 'kb', 'js', 'requests'].map((k) => [k, median(runs.map((x) => x[k]))]));
  results.push({ name, url: url.replace(BASE, ''), median: m, runs });
  const s = (ms) => `${(ms / 1000).toFixed(1)}s`;
  console.log(`${name.padEnd(26)} score ${String(m.score).padStart(3)} · FCP ${s(m.fcp)} · LCP ${s(m.lcp)} · TBT ${Math.round(m.tbt)}ms · CLS ${m.cls.toFixed(3)} · SI ${s(m.si)} · ${m.kb} KB (JS ${m.js} KB, ${m.requests} req)`);
  const opp = runs[0].opportunities;
  if (opp.length) console.log(`${''.padEnd(26)} opportunities: ${opp.join(', ')}`);
  if (process.env.PERF_DETAIL) {
    const r0 = runs[0];
    console.log(`${''.padEnd(26)} LCP element: ${r0.lcpElement}`);
    for (const x of r0.shifts) console.log(`${''.padEnd(26)} shift ${x}`);
    for (const x of r0.renderBlocking) console.log(`${''.padEnd(26)} render-blocking ${x}`);
  }
}

const MEERA = '00000004-0000-4000-8000-000000000002';
const appt = sql(`select id from appointments where doctor_id = '00000004-0000-4000-8000-000000000001' and status = 'confirmed' and start_at > now() order by start_at limit 1`);

await logout();
await measure('login (first visit)', `${BASE}/login`);
await login('9847000001');
await measure('patient home', `${BASE}/p`);
await measure('find a doctor', `${BASE}/p/doctors`);
await measure('doctor profile + slots', `${BASE}/p/doctors/${MEERA}`);
await measure('my appointments', `${BASE}/p/appointments`);
await logout();
await login('9847100001');
await measure('doctor today', `${BASE}/d`);
if (appt) await measure('doctor appointment', `${BASE}/d/appointments/${appt}`);

await ctx.close();
writeFileSync(REPORT, JSON.stringify({ base: BASE, runs: RUNS, throttling: config.settings.throttling, results }, null, 2));
console.log(`\nreport: ${REPORT}`);
