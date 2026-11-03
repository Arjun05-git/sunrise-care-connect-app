/**
 * Patient flow end-to-end against a REAL Supabase-compatible backend (local stack or `supabase start`):
 *   new user → consent → profile → home;  demo patient → discovery & filters → doctor → slot →
 *   pre-consult form + document upload → 10-minute hold with countdown → release on expiry → free follow-up confirmed;
 *   family member add / remove;  a second browser cannot take a held slot.
 *
 *   npm run stack:up && npm run dev   then   node scripts/e2e-patient.mjs http://localhost:5173
 * Needs psql (PG* env vars) to fast-forward a hold's expiry for the expiry test. Writes docs/screenshots/patient-*.png.
 */
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = process.argv[3] ?? 'docs/screenshots';
const DB = process.env.STACK_DB ?? 'sunrise_local';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const errors = [];
const ok = (s) => console.log('✓', s);
const sql = (q) => execFileSync('psql', ['-X', '-At', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
async function shot(page, name) {
  // every screen must fit the phone width (no sideways scrolling)
  const [sw, w] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  if (sw > w) throw new Error(`${name}: horizontal overflow (${sw}px > ${w}px)`);
  await page.screenshot({ path: `${OUT}/patient-${name}.png`, fullPage: true });
}

const pages = [];
process.on('uncaughtException', async (e) => {
  console.error('✗', e.message.split('\n')[0]);
  for (const [i, pg] of pages.entries()) await pg.screenshot({ path: `${OUT}/fail-${i}.png`, fullPage: true }).catch(() => {});
  if (errors.length) console.error('console errors:\n' + [...new Set(errors)].join('\n'));
  process.exit(1);
});

async function newPage(viewport = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  pages.push(page);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text()) && errors.push(m.text()));
  return page;
}
async function otpLogin(page, phone) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: 'Get OTP' }).click();
  await page.getByLabel('One-time password digit 1').fill('123456');
  await page.getByRole('button', { name: 'Verify & continue' }).click();
}

// Small valid files for upload tests
const tmp = 'node_modules/.cache/e2e';
mkdirSync(tmp, { recursive: true });
writeFileSync(`${tmp}/report.pdf`, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
writeFileSync(`${tmp}/rash.png`, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
writeFileSync(`${tmp}/fake.pdf`, 'MZ this is not a pdf');

// repeatable runs: earlier runs use up Anjali's one free follow-up with Dr Meera, so grant an override
// (admin "free follow-up" exception) – the shortcut and the free booking work on every run
sql(`set app.audit_reason = 'e2e setup';
  insert into follow_up_overrides (patient_id, doctor_id, free_count, valid_until, reason, created_by)
  values ('00000005-0000-4000-8000-000000000001', '00000004-0000-4000-8000-000000000002', 1, now() + interval '7 days', 'e2e repeatable free follow-up', '00000001-0000-4000-8000-000000000001')`);

// ---------------------------------------------------------------- 1. new user onboarding
const phoneNew = `98479990${String(Math.floor(Math.random() * 20)).padStart(2, '0')}`;
sql(`delete from consents where user_id in (select id from auth.users where phone = '91${phoneNew}');
     delete from dependents where owner_patient_id in (select id from patients where owner_user_id in (select id from auth.users where phone = '91${phoneNew}'));
     delete from patients where owner_user_id in (select id from auth.users where phone = '91${phoneNew}')`);
const n = await newPage();
await otpLogin(n, phoneNew);
await n.getByRole('heading', { name: 'Before you begin' }).waitFor();
const agree = n.getByRole('button', { name: 'Agree & continue' });
if (!(await agree.isDisabled())) throw new Error('consent button should be disabled until required boxes are ticked');
await shot(n, 'consent');
for (const label of ['Terms, refund policy & privacy', 'Use of my health data', 'Consent to teleconsultation']) await n.getByText(label).click();
await agree.click();
ok('consent: required boxes gate the button, consents saved');
await n.getByRole('heading', { name: 'Tell us about yourself' }).waitFor();
await n.getByRole('button', { name: 'Save & continue' }).click();
await n.getByText('Please enter the full name.').waitFor();
await n.getByLabel('Full name').fill('Test Patient');
await n.getByLabel('Date of birth').fill('1990-05-17');
await n.getByText('Female', { exact: true }).click();
await shot(n, 'welcome');
await n.getByRole('button', { name: 'Save & continue' }).click();
await n.getByRole('heading', { name: /Hello, Test/ }).waitFor();
ok('new patient: validation, profile created, lands on home');

// ---------------------------------------------------------------- 2. demo patient: home, discovery, filters
const p = await newPage();
await otpLogin(p, '9847000001');
await p.getByRole('heading', { name: /Hello, Anjali/ }).waitFor();
await p.getByText(/Free follow-up with/).first().waitFor();
await p.getByRole('heading', { name: 'Find by speciality' }).waitFor();
await shot(p, 'home');
ok('home: greeting, free follow-up shortcut, specialities');

await p.getByRole('link', { name: 'Cardiology' }).click();
await p.getByRole('heading', { name: 'Find a doctor' }).waitFor();
await p.getByText(/^\d+ doctors?$/).waitFor();
const cardioCount = Number((await p.getByText(/^\d+ doctors?$/).textContent()).split(' ')[0]);
const cardioDb = Number(sql(`select count(*) from doctors d join departments x on x.id = d.department_id where x.name = 'Cardiology' and d.active and d.verification_status = 'verified'`));
if (cardioCount !== cardioDb) throw new Error(`expected ${cardioDb} verified cardiologists, got ${cardioCount}`);
await p.getByRole('button', { name: 'Remove filter: Cardiology' }).click();
await p.getByText('9 doctors').waitFor();
await p.getByRole('button', { name: 'Filters' }).click();
await p.getByRole('dialog').getByLabel('Consultation type').click();
await p.getByRole('option', { name: 'Audio' }).click();
await p.getByRole('button', { name: /Show \d+ doctors?/ }).click();
await p.getByRole('button', { name: 'Remove filter: Audio' }).waitFor();
await p.getByLabel('Search doctors').fill('zzzz');
await p.getByText('No doctors match').waitFor();
await shot(p, 'doctors-empty');
await p.getByRole('button', { name: 'Clear filters' }).first().click();
await p.getByText('9 doctors').waitFor();
await shot(p, 'doctors');
ok('discovery: speciality, mode, search, empty state, clear');

// ---------------------------------------------------------------- 3. doctor profile + slot (paid, Dr Arun)
await p.getByRole('link', { name: 'Dr. Arun Nair' }).first().click();
await p.getByText('Choose a time').waitFor();
await p.getByText(/Reg\. no\. TCMC/).waitFor();
const firstSlot = p.locator('button[aria-pressed]:not([disabled])').filter({ hasText: /\d:\d\d/ }).first();
await firstSlot.click();
await p.getByText(/Consultation fee/).waitFor();
await shot(p, 'doctor');
ok('doctor profile: registration shown, slot picked, fee preview');
await p.getByRole('button', { name: 'Continue' }).click();

// ---------------------------------------------------------------- 4. pre-consult form + documents
await p.getByRole('heading', { name: 'About the problem' }).waitFor();
await p.getByRole('button', { name: 'Continue to review' }).click();
await p.getByText('Choose where the problem is.').waitFor();
await p.getByRole('radio', { name: 'Head' }).click();
await p.getByRole('button', { name: 'Headache' }).click();
await p.getByRole('button', { name: 'Chest pain' }).click();
await p.getByRole('alert').filter({ hasText: 'severe or sudden' }).waitFor();
await p.getByRole('button', { name: 'Chest pain' }).click();
await p.getByRole('radio', { name: '1–3 days' }).click();
await p.getByLabel('Describe it in your own words').fill('Throbbing headache since two days, worse in the evening.');
await p.getByRole('button', { name: /Add BP, sugar or temperature/ }).click();
await p.getByLabel('BP (mmHg)').fill('12080');
await p.getByLabel('Temp (°F)').fill('100.2');
await p.setInputFiles('#doc-input', `${tmp}/fake.pdf`);
await p.getByText("fake.pdf doesn't look like a real PDF").waitFor();
await p.setInputFiles('#doc-input', [`${tmp}/report.pdf`, `${tmp}/rash.png`]);
await p.getByRole('button', { name: 'Preview report.pdf' }).waitFor();
await p.getByRole('button', { name: 'Preview rash.png' }).click();
await p.getByRole('dialog').getByRole('img', { name: 'rash.png' }).waitFor();
await p.keyboard.press('Escape');
await p.getByRole('button', { name: 'Delete rash.png' }).click();
await p.getByText('Document deleted').waitFor();
await p.getByRole('button', { name: 'Continue to review' }).click();
await p.getByText('Use the format 120/80.').waitFor();
await p.getByLabel('BP (mmHg)').fill('120/80');
await shot(p, 'preconsult');
await p.getByRole('button', { name: 'Continue to review' }).click();
ok('pre-consult: validation, red-flag warning, vitals, upload with type sniffing, preview, delete');

// ---------------------------------------------------------------- 5. review: hold + countdown
await p.getByRole('heading', { name: 'Review & confirm' }).waitFor();
await p.getByText('Slot held for you').waitFor();
const t1 = await p.getByRole('timer').getAttribute('aria-label');
if (!/Slot held for (09:5\d|10:00)/.test(t1)) throw new Error(`unexpected countdown: ${t1}`);
await p.getByText('1 document attached').waitFor();
await p.waitForTimeout(2100);
const t2 = await p.getByRole('timer').getAttribute('aria-label');
if (t1 === t2) throw new Error('countdown is not ticking');
const apptId = p.url().split('/').pop();
if (sql(`select status from appointments where id = '${apptId}'`) !== 'pending_payment') throw new Error('hold not in DB');
if (sql(`select s.status from slots s join appointments a on a.slot_id = s.id where a.id = '${apptId}'`) !== 'held') throw new Error('slot not held');
await shot(p, 'review');
ok(`review: hold in DB (pending_payment, slot held), countdown ticking (${t1} → ${t2})`);

// another patient cannot take the held slot
const slotStart = sql(`select to_char(start_at at time zone 'Asia/Kolkata', 'FMHH12:MI') from appointments where id = '${apptId}'`);
const r = await newPage();
await otpLogin(r, '9847000002');
await r.getByRole('heading', { name: /Hello/ }).waitFor();
await r.goto(`${BASE}/p/doctors/${sql(`select doctor_id from appointments where id = '${apptId}'`)}`);
await r.getByText('Choose a time').waitFor();
const heldBtn = r.getByRole('button', { name: new RegExp(`^${slotStart} [AP]M – not available`, 'i') });
await heldBtn.first().waitFor();
ok('a second patient sees the held slot as unavailable');

// paid booking: closing the checkout keeps the hold (payment itself is covered by e2e-payments-ui.mjs)
await p.getByRole('button', { name: /^Pay ₹/ }).click();
await p.getByRole('dialog', { name: 'Test payment' }).waitFor();
await p.keyboard.press('Escape');
await p.getByText(/Payment cancelled\. Your slot is still held/).waitFor();

// expiry: fast-forward the server clock for this hold, then the client timer runs out → release
sql(`update appointments set hold_expires_at = now() + interval '3 seconds' where id = '${apptId}'`);
await p.reload();
await p.getByRole('heading', { name: 'Your slot hold has ended' }).waitFor({ timeout: 15000 });
await p.waitForTimeout(500);
const after = sql(`select a.status || '/' || a.outcome || '/' || s.status from appointments a join slots s on s.id = a.slot_id where a.id = '${apptId}'`);
if (after !== 'cancelled/payment_expired/open') throw new Error(`after expiry: ${after}`);
await shot(p, 'expired');
ok(`expiry: countdown hit 0 → released (${after})`);

// ---------------------------------------------------------------- 6. free follow-up end to end
await p.goto(`${BASE}/p`);
await p.getByText(/Free follow-up with/).first().click();
await p.getByText('Choose a time').waitFor();
// a few days out, so it can't clash with bookings other tests created for this patient today
await p.locator('[role="option"]:not([disabled])').nth(3).click();
await p.locator('button[aria-pressed]:not([disabled])').filter({ hasText: /\d:\d\d/ }).first().click();
await p.getByText('Free follow-up', { exact: true }).waitFor();
await p.getByRole('button', { name: 'Continue' }).click();
await p.getByRole('radio', { name: 'Skin & hair' }).click();
await p.getByRole('radio', { name: '4–7 days' }).click();
await p.getByLabel('Describe it in your own words').fill('Rash is better but still itchy at night.');
await p.getByRole('button', { name: 'Continue to review' }).click();
await p.getByRole('button', { name: 'Confirm booking' }).click();
await p.getByRole('heading', { name: 'Booking confirmed' }).waitFor();
await shot(p, 'confirmed');
ok('free follow-up: confirmed without payment');

// ---------------------------------------------------------------- 7. family members
await p.goto(`${BASE}/p/profile`);
await p.getByRole('heading', { name: 'Me & family' }).waitFor();
await p.getByRole('link', { name: 'Add' }).click();
await p.getByLabel('Full name').fill('Kuttan Menon');
await p.getByLabel('Date of birth').fill('2019-03-02');
await p.getByText('Male', { exact: true }).click();
await p.getByRole('button', { name: 'Save' }).click();
await p.getByText('Choose how this person is related to you.').or(p.getByText('This field is required.')).first().waitFor();
await p.getByLabel('Relationship to you').click();
await p.getByRole('option', { name: 'Child' }).click();
await p.getByRole('button', { name: 'Save' }).click();
await p.getByText('Kuttan Menon').waitFor();
await shot(p, 'profile');
await p.getByRole('button', { name: 'Remove Kuttan Menon' }).click();
await p.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
await p.getByText('Family member removed').waitFor();
if (sql(`select count(*) from patients where full_name = 'Kuttan Menon' and archived_at is not null`) === '0') throw new Error('member not archived');
ok('family: add with validation, remove = archive');

// ---------------------------------------------------------------- 8. desktop + Malayalam + dark
const d = await newPage({ width: 1280, height: 860 });
await otpLogin(d, '9847000001');
await d.getByRole('heading', { name: /Hello, Anjali/ }).waitFor();
await d.goto(`${BASE}/p/doctors`);
await d.getByText('9 doctors').waitFor();
await shot(d, 'doctors-desktop');
await d.evaluate(() => localStorage.setItem('scc-prefs', JSON.stringify({ theme: 'dark', fontScale: 1, language: 'ml' })));
await d.goto(`${BASE}/p`);
await d.getByRole('heading', { name: /നമസ്കാരം/ }).waitFor();
await shot(d, 'home-ml-dark');
ok('desktop layout, Malayalam + dark mode');

await browser.close();
if (errors.length) {
  console.error('✗ console errors:\n' + [...new Set(errors)].join('\n'));
  process.exit(1);
}
console.log('\nall patient e2e checks passed');
