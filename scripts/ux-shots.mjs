/**
 * Visual review screenshots: every main screen of each role at a small phone (360 px) and a large desktop
 * (1920 px), plus the states people rarely see in testing – empty (a brand-new patient), error (API down)
 * and loading (slow API). Writes PNGs and contact sheets for side-by-side review.
 *
 *   npm run stack:up && npm run dev   then   PGHOST=… node scripts/ux-shots.mjs http://localhost:5173 <out dir>
 */
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = process.argv[3] ?? 'ux-shots';
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const DB = process.env.STACK_DB ?? 'sunrise_local';
mkdirSync(OUT, { recursive: true });
const sql = (q) => execFileSync('psql', ['-X', '-At', '-q', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const SIZES = { phone: { width: 360, height: 780 }, desktop: { width: 1920, height: 1080 } };
const shots = [];

async function page(size) {
  const ctx = await browser.newContext({ viewport: SIZES[size], reducedMotion: 'reduce' });
  await ctx.addInitScript(() => { try { localStorage.setItem('scc-prefs', JSON.stringify({ theme: 'light', language: 'en', fontScale: 1 })); } catch {} });
  return ctx.newPage();
}
async function settle(p) {
  await p.waitForLoadState('networkidle').catch(() => {});
  await p.waitForFunction(() => !document.querySelector('.animate-pulse, [role="status"] .animate-spin'), null, { timeout: 6000 }).catch(() => {});
  await p.waitForTimeout(400);
}
async function shot(p, name, size, { settleFirst = true, full = true } = {}) {
  if (ONLY && !ONLY.test(name)) return;
  if (settleFirst) await settle(p);
  const file = `${OUT}/${size}--${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
  const [sw, w] = await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  await p.screenshot({ path: file, fullPage: full });
  shots.push({ name, size, file, overflow: sw > w ? `${sw}>${w}` : '' });
  console.log(`${sw > w ? '✗ overflow ' : '  '}${size.padEnd(7)} ${name}`);
}
/** In-app navigation (no reload), so the session is already restored when the API is blocked. */
async function spaGo(p, path) {
  await p.evaluate((to) => { window.history.pushState({}, '', to); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
}
async function otpLogin(p, phone) {
  await p.goto(`${BASE}/login`);
  if (phone.startsWith('98471')) await p.getByRole('tab', { name: 'Doctor' }).click();
  const form = p.getByRole('tabpanel');
  await form.getByLabel('Mobile number').fill(phone);
  await form.getByRole('button', { name: 'Get OTP' }).click();
  await p.getByLabel('One-time password digit 1').fill('123456');
  await p.getByRole('button', { name: 'Verify & continue' }).click();
  await p.waitForURL((u) => !u.pathname.startsWith('/login'));
}
async function staffLogin(p) {
  await p.goto(`${BASE}/login`);
  await p.getByRole('tab', { name: 'Staff' }).click();
  await p.getByLabel('Work email').fill('admin@sunrise.demo');
  await p.getByLabel('Password').fill('Sunrise@123');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.waitForURL((u) => !u.pathname.startsWith('/login'));
}

const PT = '00000005-0000-4000-8000-000000000001';
const MEERA = '00000004-0000-4000-8000-000000000002';
const rx = sql(`select id || '|' || verification_code from prescriptions where patient_id = '${PT}' and status = 'final' order by finalized_at desc limit 1`).split('|');
const appt = sql(`select id from appointments where doctor_id = '00000004-0000-4000-8000-000000000001' and status = 'confirmed' and start_at > now() order by start_at limit 1`);
const docId = sql(`select id from doctors where verification_status = 'verified' order by full_name limit 1`);
const ticket = sql(`select id from support_tickets where user_id = '00000001-0000-4000-8000-0000000000c8' order by created_at desc limit 1`);
const patients = sql(`select p.id from patients p join appointments a on a.patient_id = p.id where a.doctor_id = '00000004-0000-4000-8000-000000000001' limit 1`);

for (const size of ['phone', 'desktop']) {
  // ---------------------------------------------------------------- public
  const pub = await page(size);
  for (const [path, name] of [['/login', 'login'], ['/legal/terms_of_use', 'legal'], ...(rx[1] ? [[`/verify/${rx[1]}`, 'verify-valid']] : []), ['/verify/NOTACODE00', 'verify-not-found'], ['/nope', '404']]) {
    await pub.goto(`${BASE}${path}`); await shot(pub, `public ${name}`, size);
  }
  await pub.getByRole('link').first().waitFor().catch(() => {});
  await pub.context().close();

  // ---------------------------------------------------------------- patient
  const p = await page(size);
  await otpLogin(p, '9847000001');
  for (const [path, name] of [['/p', 'home'], ['/p/doctors', 'find doctors'], ['/p/doctors?q=zzzz', 'find doctors no results'], [`/p/doctors/${MEERA}`, 'doctor profile'],
    ['/p/appointments', 'appointments'], ['/p/records', 'records'], ...(rx[0] ? [[`/p/records/${rx[0]}`, 'prescription']] : []), ['/p/profile', 'profile'],
    [`/p/profile/family/${PT}`, 'family member'], ['/p/profile/family/new', 'family add'], ['/p/help', 'help'], ...(ticket ? [[`/p/help/${ticket}`, 'ticket']] : [])]) {
    await p.goto(`${BASE}${path}`); await shot(p, `patient ${name}`, size);
  }
  // booking flow states
  await p.goto(`${BASE}/p/doctors/${MEERA}`);
  await p.locator('[role="option"]:not([disabled])').nth(5).click();
  await p.locator('button[aria-pressed]:not([disabled])').filter({ hasText: /\d:\d\d/ }).first().click();
  await shot(p, 'patient doctor profile slot picked', size);
  await p.getByRole('button', { name: 'Continue' }).click();
  await p.getByRole('radio', { name: 'Whole body / general' }).waitFor();
  await shot(p, 'patient symptoms form', size);
  await p.getByRole('button', { name: 'Continue to review' }).click();
  await p.waitForTimeout(500);
  await shot(p, 'patient symptoms form errors', size);
  await p.getByRole('radio', { name: 'Whole body / general' }).click();
  await p.getByRole('radio', { name: 'Today' }).click();
  await p.getByLabel('Describe it in your own words').fill('Review screenshots.');
  await p.getByRole('button', { name: 'Continue to review' }).click();
  await p.getByText('Slot held for you').waitFor();
  await shot(p, 'patient review hold', size);
  if (await p.getByRole('button', { name: /^Pay ₹/ }).count()) {   // a free follow-up has no payment step
    await p.getByRole('button', { name: /^Pay ₹/ }).click();
    await p.getByRole('dialog').waitFor();
    await shot(p, 'patient checkout dialog', size, { full: false });
    await p.keyboard.press('Escape');
  }
  await p.getByRole('button', { name: /Change doctor or time/ }).click().catch(() => {});
  // error state: API down after sign-in (each screen loads its data afresh)
  await p.goto(`${BASE}/p/help`); await settle(p);
  await p.route('**/rest/v1/**', (r) => r.abort());
  for (const [path, name] of [['/p/appointments', 'appointments ERROR'], ['/p/doctors', 'find doctors ERROR'], ['/p/records', 'records ERROR']]) {
    await spaGo(p, path); await p.waitForTimeout(5500); await shot(p, `patient ${name}`, size, { settleFirst: false });
  }
  await p.unroute('**/rest/v1/**');
  // loading state: slow API
  await p.goto(`${BASE}/p/help`); await settle(p);
  await p.route('**/rest/v1/**', async (r) => { await new Promise((ok) => setTimeout(ok, 8000)); await r.continue().catch(() => {}); });
  for (const [path, name] of [['/p/profile', 'profile LOADING'], ['/p/doctors?q=a', 'find doctors LOADING']]) {
    await spaGo(p, path); await p.waitForTimeout(1200); await shot(p, `patient ${name}`, size, { settleFirst: false });
  }
  await p.unroute('**/rest/v1/**');
  // start-up with no connection to the service: the boot screen must not spin forever
  await p.route('**/rest/v1/**', (r) => r.abort());
  await p.goto(`${BASE}/p`).catch(() => {}); await p.waitForTimeout(9500); await shot(p, 'patient start-up, service unreachable', size, { settleFirst: false });
  await p.unroute('**/rest/v1/**');
  await p.context().close();

  // empty states: a brand-new patient
  const phone = sql(`select '98479990' || lpad(n::text, 2, '0') from generate_series(0, 19) n where not exists (select 1 from auth.users u where u.phone = '9198479990' || lpad(n::text, 2, '0')) order by n limit 1`);
  if (phone) {
    const n = await page(size);
    await otpLogin(n, phone);
    await shot(n, 'new patient consent', size);
    for (const label of ['Terms, refund policy & privacy', 'Use of my health data', 'Consent to teleconsultation']) await n.getByText(label).click();
    await n.getByRole('button', { name: 'Agree & continue' }).click();
    await n.getByRole('heading', { name: 'Tell us about yourself' }).waitFor();
    await shot(n, 'new patient welcome', size);
    await n.getByLabel('Full name').fill('Asha Varghese'); await n.getByLabel('Date of birth').fill('1994-03-11'); await n.getByText('Female', { exact: true }).click();
    await n.getByRole('button', { name: 'Save & continue' }).click();
    await n.getByRole('heading', { name: /Hello/ }).waitFor();
    for (const [path, name] of [['/p', 'home EMPTY'], ['/p/appointments', 'appointments EMPTY'], ['/p/records', 'records EMPTY'], ['/p/help', 'help EMPTY']]) {
      await n.goto(`${BASE}${path}`); await shot(n, `patient ${name}`, size);
    }
    await n.context().close();
  }

  // ---------------------------------------------------------------- doctor
  const d = await page(size);
  await otpLogin(d, '9847100001');
  for (const [path, name] of [['/d', 'today'], ...(appt ? [[`/d/appointments/${appt}`, 'appointment'], [`/d/appointments/${appt}/write`, 'notes + rx']] : []),
    ['/d/calendar', 'calendar'], ['/d/availability', 'availability'], ['/d/patients', 'patients'], ...(patients ? [[`/d/patients/${patients}`, 'patient timeline']] : []),
    ['/d/profile', 'profile'], ['/d/profile/signature', 'signature']]) {
    await d.goto(`${BASE}${path}`); await shot(d, `doctor ${name}`, size);
  }
  await d.goto(`${BASE}/d/profile`); await settle(d);
  await d.route('**/rest/v1/**', (r) => r.abort());
  await spaGo(d, '/d/patients'); await d.waitForTimeout(5500); await shot(d, 'doctor patients ERROR', size, { settleFirst: false });
  await d.unroute('**/rest/v1/**');
  await d.context().close();

  // ---------------------------------------------------------------- admin
  const a = await page(size);
  await staffLogin(a);
  for (const [path, name] of [['/a', 'dashboard'], ['/a/appointments', 'appointments'], ['/a/doctors', 'doctors'], [`/a/doctors/${docId}`, 'doctor detail'], ['/a/masters', 'masters'],
    ['/a/fees', 'fees'], ['/a/policies', 'policies'], ['/a/payments', 'payments'], ['/a/notifications', 'notifications'], ['/a/support', 'support'], ['/a/content', 'content'],
    ['/a/users', 'users'], ['/a/audit', 'audit'], ['/a/reports', 'reports'], ['/a/integrations', 'integrations'], ['/a/settings', 'settings']]) {
    await a.goto(`${BASE}${path}`); await shot(a, `admin ${name}`, size);
  }
  await a.goto(`${BASE}/a/settings`); await settle(a);
  await a.route('**/rest/v1/**', (r) => r.abort());
  await spaGo(a, '/a/payments'); await a.waitForTimeout(5500); await shot(a, 'admin payments ERROR', size, { settleFirst: false });
  await a.unroute('**/rest/v1/**');
  await a.context().close();
}
await browser.close();

// ---------------------------------------------------------------- contact sheets (python + PIL)
const list = JSON.stringify(shots);
execFileSync('python3', ['-c', `
import json, sys, math
from PIL import Image, ImageDraw
shots = json.loads(sys.argv[1]); out = sys.argv[2]
for size, per, cell_w, max_h in [('phone', 6, 360, 1500), ('desktop', 2, 960, 900)]:
    items = [s for s in shots if s['size'] == size]
    for k in range(math.ceil(len(items) / per)):
        group = items[k*per:(k+1)*per]
        tiles = []
        for s in group:
            im = Image.open(s['file']).convert('RGB')
            scale = cell_w / im.width
            im = im.resize((cell_w, max(1, int(im.height * scale))))
            im = im.crop((0, 0, cell_w, min(im.height, max_h)))
            tiles.append((s, im))
        H = max(im.height for _, im in tiles) + 28
        sheet = Image.new('RGB', (len(tiles) * (cell_w + 12) + 12, H + 12), 'white')
        dr = ImageDraw.Draw(sheet)
        for i, (s, im) in enumerate(tiles):
            x = 12 + i * (cell_w + 12)
            dr.text((x, 6), s['name'] + ('  OVERFLOW ' + s['overflow'] if s['overflow'] else ''), fill='red' if s['overflow'] else 'black')
            sheet.paste(im, (x, 28))
        sheet.save(f"{out}/sheet-{size}-{k+1:02d}.png")
print('sheets written')
`, list, OUT], { stdio: 'inherit' });
