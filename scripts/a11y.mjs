/**
 * Accessibility check: axe-core (WCAG 2.0 / 2.1, levels A + AA) on every main screen of the three roles,
 * light and dark theme, phone width for patients and doctors, desktop for staff – plus the states that
 * only exist after an action (checkout dialog, sign dialog, reason dialog, MFA enrolment).
 * Fails (exit 1) on any violation; writes a JSON report.
 *
 *   npm run stack:up && npm run dev   then   PGHOST=… PGPORT=… PGUSER=postgres node scripts/a11y.mjs http://localhost:5173 [report.json]
 */
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const REPORT = process.argv[3] ?? 'a11y-report.json';
const DB = process.env.STACK_DB ?? 'sunrise_local';
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const sql = (q) => execFileSync('psql', ['-X', '-At', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const results = [];
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1366, height: 900 };

async function context(theme, viewport, fontScale = 1) {
  const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  await ctx.addInitScript(([t, f]) => { try { localStorage.setItem('scc-prefs', JSON.stringify({ theme: t, language: 'en', fontScale: f })); } catch {} }, [theme, fontScale]);
  return ctx.newPage();
}
async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"], .animate-pulse'), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(300);
}
async function scan(page, name, theme) {
  await settle(page);
  if (!(await page.evaluate(() => 'axe' in window))) await page.addScriptTag({ content: AXE });
  const r = await page.evaluate(async (tags) => {
    const out = await window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return out.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map((n) => ({ target: n.target.join(' '), summary: n.failureSummary?.split('\n').slice(0, 3).join(' ') })), count: v.nodes.length }));
  }, TAGS);
  results.push({ page: name, theme, url: page.url().replace(BASE, ''), violations: r });
  const n = r.reduce((s, v) => s + v.count, 0);
  console.log(`${n ? '✗' : '✓'} ${theme.padEnd(5)} ${name}${n ? `  – ${r.map((v) => `${v.id}×${v.count}`).join(', ')}` : ''}`);
  if (process.env.A11Y_DETAIL) for (const v of r) for (const node of v.nodes) console.log(`      ${v.id}: ${node.target}  | ${node.summary}`);
}
/** WCAG 1.4.10 reflow: at 320 CSS px (≈ 400% zoom of 1280) nothing may need sideways scrolling. */
async function reflow(page, name) {
  await settle(page);
  const [sw, w] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  const v = sw > w ? [{ id: 'reflow-320', impact: 'serious', help: 'Content must reflow at 320 CSS px without horizontal scrolling', nodes: [{ target: 'html', summary: `scrollWidth ${sw}px > ${w}px` }], count: 1 }] : [];
  results.push({ page: name, theme: 'light', url: page.url().replace(BASE, ''), violations: v });
  console.log(`${v.length ? '✗' : '✓'} 320px  ${name}${v.length ? `  – ${v[0].nodes[0].summary}` : ''}`);
}
async function otpLogin(page, phone) {
  await page.goto(`${BASE}/login`);
  if (phone.startsWith('98471')) await page.getByRole('tab', { name: 'Doctor' }).click();
  const form = page.getByRole('tabpanel');
  await form.getByLabel('Mobile number').fill(phone);
  await form.getByRole('button', { name: 'Get OTP' }).click();
  await page.getByLabel('One-time password digit 1').fill('123456');
  await page.getByRole('button', { name: 'Verify & continue' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}
async function staffLogin(page, email) {
  await page.goto(`${BASE}/login`);
  await page.getByRole('tab', { name: 'Staff' }).click();
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill('Sunrise@123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}

const PT = '00000005-0000-4000-8000-000000000001';
const MEERA = '00000004-0000-4000-8000-000000000002';
const rx = sql(`select id || '|' || verification_code from prescriptions where patient_id = '${PT}' and status = 'final' order by finalized_at desc limit 1`).split('|');
const arunAppt = sql(`select a.id from appointments a where a.doctor_id = '00000004-0000-4000-8000-000000000001' and a.status = 'confirmed' and a.start_at > now() order by a.start_at limit 1`);
const doctorId = sql(`select id from doctors where verification_status = 'verified' order by full_name limit 1`);

for (const theme of ['light', 'dark']) {
  // ---------------------------------------------------------------- public
  const pub = await context(theme, PHONE);
  await pub.goto(`${BASE}/login`); await scan(pub, 'login – patient', theme);
  await pub.getByRole('tab', { name: 'Staff' }).click(); await scan(pub, 'login – staff', theme);
  await pub.goto(`${BASE}/legal/terms_of_use`); await scan(pub, 'legal page', theme);
  if (rx[1]) { await pub.goto(`${BASE}/verify/${rx[1]}`); await scan(pub, 'public prescription check', theme); }
  await pub.goto(`${BASE}/nope`); await scan(pub, '404', theme);
  await pub.context().close();

  // ---------------------------------------------------------------- patient (phone)
  const p = await context(theme, PHONE);
  await otpLogin(p, '9847000001');
  for (const [path, name] of [['/p', 'home'], ['/p/doctors', 'find a doctor'], [`/p/doctors/${MEERA}`, 'doctor + slots'], ['/p/appointments', 'appointments'],
    ['/p/records', 'records'], ...(rx[0] ? [[`/p/records/${rx[0]}`, 'prescription']] : []), ['/p/profile', 'profile'], [`/p/profile/family/${PT}`, 'family member'],
    ['/p/help', 'help & support']]) {
    await p.goto(`${BASE}${path}`); await scan(p, `patient – ${name}`, theme);
  }
  if (theme === 'light') {   // booking states (once: they create a hold)
    await p.goto(`${BASE}/p/doctors/${MEERA}`);
    await p.locator('[role="option"]:not([disabled])').nth(5).click();
    await p.locator('button[aria-pressed]:not([disabled])').filter({ hasText: /\d:\d\d/ }).first().click();
    await p.getByRole('button', { name: 'Continue' }).click();
    await p.getByRole('radio', { name: 'Whole body / general' }).waitFor(); await scan(p, 'patient – symptoms form', theme);
    await p.getByRole('button', { name: 'Continue to review' }).click();
    await p.getByText('Please').first().waitFor().catch(() => {}); await scan(p, 'patient – form with errors', theme);
    await p.getByRole('radio', { name: 'Whole body / general' }).click();
    await p.getByRole('radio', { name: 'Today' }).click();
    await p.getByLabel('Describe it in your own words').fill('Accessibility check booking.');
    await p.getByRole('button', { name: 'Continue to review' }).click();
    await p.getByText('Slot held for you').waitFor(); await scan(p, 'patient – review + hold', theme);
    const pay = p.getByRole('button', { name: /^Pay ₹/ });
    if (await pay.count()) { await pay.click(); await p.getByRole('dialog').waitFor(); await scan(p, 'patient – checkout dialog', theme); await p.keyboard.press('Escape'); }
    const release = p.getByRole('button', { name: /Change doctor or time/ });
    if (await release.count()) await release.click();
  }
  await p.context().close();

  // ---------------------------------------------------------------- doctor (phone)
  const d = await context(theme, PHONE);
  await otpLogin(d, '9847100001');
  for (const [path, name] of [['/d', 'today'], ...(arunAppt ? [[`/d/appointments/${arunAppt}`, 'appointment'], [`/d/appointments/${arunAppt}/write`, 'notes + prescription']] : []),
    ['/d/calendar', 'calendar'], ['/d/availability', 'availability'], ['/d/patients', 'patients'], ['/d/profile', 'profile'], ['/d/profile/signature', 'signature & PIN']]) {
    await d.goto(`${BASE}${path}`); await scan(d, `doctor – ${name}`, theme);
  }
  if (arunAppt && theme === 'light') {
    await d.goto(`${BASE}/d/appointments/${arunAppt}`);
    const propose = d.getByRole('button', { name: 'Propose another time today' });
    if (await propose.count()) { await propose.click(); await d.getByRole('dialog').waitFor(); await scan(d, 'doctor – reschedule dialog', theme); await d.keyboard.press('Escape'); }
  }
  await d.context().close();

  // ---------------------------------------------------------------- staff (desktop)
  const a = await context(theme, DESKTOP);
  await staffLogin(a, 'admin@sunrise.demo');
  for (const [path, name] of [['/a', 'dashboard'], ['/a/appointments', 'appointment monitor'], ['/a/doctors', 'doctors'], [`/a/doctors/${doctorId}`, 'doctor detail'],
    ['/a/masters', 'masters'], ['/a/fees', 'fees'], ['/a/policies', 'policies'], ['/a/payments', 'payments'], ['/a/notifications', 'notifications'], ['/a/support', 'support'],
    ['/a/content', 'consent & terms'], ['/a/users', 'users & roles'], ['/a/audit', 'audit log'], ['/a/reports', 'reports'], ['/a/integrations', 'integrations'], ['/a/settings', 'settings']]) {
    await a.goto(`${BASE}${path}`); await scan(a, `admin – ${name}`, theme);
  }
  if (theme === 'light') {
    await a.goto(`${BASE}/a/fees`);
    await a.getByRole('button', { name: /^Edit fee:/ }).first().click();
    await a.getByRole('dialog').waitFor(); await scan(a, 'admin – reason dialog', theme); await a.keyboard.press('Escape');
  }
  await a.context().close();

  // ---------------------------------------------------------------- staff MFA enrolment
  sql(`update app_settings set value = 'true' where key = 'staff_mfa_required'; delete from auth.mfa_factors where user_id = '00000001-0000-4000-8000-000000000003'`);
  try {
    const m = await context(theme, PHONE);
    await staffLogin(m, 'coordinator@sunrise.demo');
    await m.waitForURL(/\/mfa$/);
    await m.locator('[data-ref="mfa-qr"]').waitFor();
    await scan(m, 'staff – MFA enrolment', theme);
    await m.context().close();
  } finally {
    sql(`update app_settings set value = 'false' where key = 'staff_mfa_required'; delete from auth.mfa_factors where user_id = '00000001-0000-4000-8000-000000000003'`);
  }
}

// ---------------------------------------------------------------- reflow at 320 px with the largest text size (130 %)
for (const [who, login, paths] of [
  ['patient', (pg) => otpLogin(pg, '9847000001'), ['/p', '/p/doctors', `/p/doctors/${MEERA}`, '/p/appointments', '/p/records', ...(rx[0] ? [`/p/records/${rx[0]}`] : []), '/p/profile', '/p/help']],
  ['doctor', (pg) => otpLogin(pg, '9847100001'), ['/d', ...(arunAppt ? [`/d/appointments/${arunAppt}`, `/d/appointments/${arunAppt}/write`] : []), '/d/calendar', '/d/availability', '/d/patients']],
]) {
  const pg = await context('light', { width: 320, height: 640 }, 1.3);
  await login(pg);
  for (const path of paths) { await pg.goto(`${BASE}${path}`); await reflow(pg, `${who} ${path.replace(/[0-9a-f-]{36}/, ':id')}`); }
  await pg.context().close();
}
const lp = await context('light', { width: 320, height: 640 }, 1.3);
await lp.goto(`${BASE}/login`); await reflow(lp, 'login');
await lp.context().close();

await browser.close();
writeFileSync(REPORT, JSON.stringify(results, null, 2));
const failing = results.filter((r) => r.violations.length);
const byRule = {};
for (const r of failing) for (const v of r.violations) (byRule[v.id] ??= { impact: v.impact, help: v.help, pages: [], nodes: 0 }).pages.push(`${r.theme}: ${r.page}`), (byRule[v.id].nodes += v.count);
console.log(`\n${results.length} screens checked (${TAGS.join(', ')}), ${failing.length} with violations`);
for (const [id, v] of Object.entries(byRule)) console.log(`  ${v.impact.padEnd(8)} ${id} – ${v.help} (${v.nodes} elements on ${v.pages.length} screens)`);
process.exit(failing.length ? 1 : 0);
