/**
 * The five critical journeys, end to end against the live local stack, for ONE brand-new patient per run
 * (a fresh test number 98479991NN), so every run starts from nothing and leaves other suites' data alone:
 *
 *   1. Book and pay       – sign-up → consent → profile → doctor → slot → symptoms → 10-min hold → UPI
 *                            payment → confirmed; the server's fee, the captured payment, the booked slot,
 *                            the confirmation message and the receipt PDF all agree.
 *   2. Free follow-up      – after a completed consultation the home screen offers a free follow-up →
 *                            booked at ₹0 with no payment; the second one with the same doctor is a paid
 *                            follow-up (policy: 1 free follow-up within 14 days).
 *   3. Same-day reschedule – the doctor proposes a later time today → the patient sees it live → accepts →
 *                            the booking moves with its payment, the old slot reopens, both messages sent.
 *   4. Doctor cancels      – "I can't take this consultation" → the patient sees the choice live → full
 *                            refund → refund processed for the whole amount, payment marked refunded.
 *   5. Prescription        – audio first consultation: List A and Prohibited drugs are blocked with the
 *                            reason (UI and API), an allowed drug is signed with the PIN → final, numbered,
 *                            PDF stored; the patient sees it and the public QR check says valid.
 *
 *   npm run stack:up && npm run dev   then   PGHOST=… PGPORT=… PGUSER=postgres node scripts/e2e-journeys.mjs http://localhost:5173
 */
import { chromium } from 'playwright-core';
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = process.argv[3] ?? 'docs/screenshots';
const API = process.env.SUPABASE_LOCAL_URL ?? 'http://127.0.0.1:54321';
const DB = process.env.STACK_DB ?? 'sunrise_local';
mkdirSync(OUT, { recursive: true });
const sql = (q) => execFileSync('psql', ['-X', '-At', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const keys = Object.fromEntries(readFileSync('.local-stack/keys.env', 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
const ok = (s) => console.log('✓', s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(400);
  }
}
const expectEq = (what, actual, expected) => { if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`); };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const errors = [];
const pages = [];
process.on('uncaughtException', async (e) => {
  console.error('✗', e.message.split('\n')[0], (e.stack ?? '').split('\n').find((l) => l.includes('e2e-journeys.mjs:')) ?? '');
  for (const [i, pg] of pages.entries()) await pg.screenshot({ path: `${OUT}/fail-journeys-${i}.png`, fullPage: true }).catch(() => {});
  if (errors.length) console.error('console errors:\n' + [...new Set(errors)].join('\n'));
  process.exit(1);
});
async function newPage(viewport) {
  const page = await (await browser.newContext({ viewport, acceptDownloads: true })).newPage();
  pages.push(page);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|fonts\.g|WebSocket/.test(m.text()) && errors.push(m.text()));
  return page;
}
async function shot(page, name) {
  const [sw, w] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  if (sw > w) throw new Error(`${name}: horizontal overflow (${sw}px > ${w}px)`);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
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
const rupeesOf = (s) => Number(String(s).replace(/[^\d]/g, ''));
const timeLabel = (iso) => new RegExp(`^${sql(`select to_char('${iso}'::timestamptz at time zone 'Asia/Kolkata', 'FMHH12:MI')`)} [ap]m$`, 'i');

const ARUN_DOC = '00000004-0000-4000-8000-000000000001';
const ARUN = '00000001-0000-4000-8000-000000000064';
const MEERA_DOC = '00000004-0000-4000-8000-000000000002';

// ---------------------------------------------------------------- a fresh patient for this run
const phone = sql(`select '98479991' || lpad(n::text, 2, '0') from generate_series(0, 99) n
  where not exists (select 1 from auth.users u where u.phone = '9198479991' || lpad(n::text, 2, '0')) order by n limit 1`);
if (!phone) throw new Error('all 100 journey test numbers are used – run npm run stack:up for a fresh database');
const p = await newPage({ width: 390, height: 844 });

// ================================================================ 1. BOOK AND PAY
await otpLogin(p, phone);
await p.getByRole('heading', { name: 'Before you begin' }).waitFor();
for (const label of ['Terms, refund policy & privacy', 'Use of my health data', 'Consent to teleconsultation']) await p.getByText(label).click();
await p.getByRole('button', { name: 'Agree & continue' }).click();
await p.getByRole('heading', { name: 'Tell us about yourself' }).waitFor();
await p.getByLabel('Full name').fill('Journey Tester');
await p.getByLabel('Date of birth').fill('1987-08-21');
await p.getByText('Male', { exact: true }).click();
await p.getByRole('button', { name: 'Save & continue' }).click();
await p.getByRole('heading', { name: /Hello, Journey/ }).waitFor();
const USER = sql(`select id from auth.users where phone = '91${phone}'`);
const PT = sql(`select id from patients where owner_user_id = '${USER}' and is_primary`);

await p.goto(`${BASE}/p/doctors`);
await p.getByText('Dr. Meera Krishnan').first().waitFor();
await p.goto(`${BASE}/p/doctors/${MEERA_DOC}`);
await p.getByText('Choose a time').waitFor();
await p.locator('button[aria-pressed]:not([disabled])').filter({ hasText: /\d:\d\d/ }).first().click();
await p.getByText('Consultation fee').waitFor();
await p.getByRole('button', { name: 'Continue' }).click();
await p.getByRole('radio', { name: 'Whole body / general' }).click();
await p.getByRole('radio', { name: 'Today' }).click();
await p.getByLabel('Describe it in your own words').fill('Fever and body ache since this morning.');
await p.getByRole('button', { name: 'Continue to review' }).click();
await p.getByText('Slot held for you').waitFor();
const holdId = p.url().split('/').pop();
expectEq('hold status', sql(`select status || '/' || (hold_expires_at > now() + interval '9 minutes') from appointments where id = '${holdId}'`), 'pending_payment/true');
const payButton = p.getByRole('button', { name: /^Pay ₹/ });
const shownAmount = rupeesOf(await payButton.textContent());
await payButton.click();
const dlg = p.getByRole('dialog', { name: 'Test payment' });
await dlg.getByRole('radio', { name: 'UPI' }).click();
await dlg.getByRole('button', { name: /^Pay ₹/ }).click();
await p.getByRole('heading', { name: 'Booking confirmed' }).waitFor();
const [rcpt] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: /Download receipt SCR-/ }).click()]);
expectEq('receipt is a PDF', readFileSync(await rcpt.path()).subarray(0, 5).toString(), '%PDF-');
await shot(p, 'journey-1-booked');
const j1 = sql(`select a.status || '|' || a.fee_amount || '|' || a.consult_type || '|' || s.status || '|' || (s.appointment_id = a.id) || '|' || pay.status || '|' || pay.amount || '|' || (pay.receipt_no is not null)
  from appointments a join slots s on s.id = a.slot_id join payments pay on pay.appointment_id = a.id where a.id = '${holdId}'`).split('|');
expectEq('appointment', j1.slice(0, 3).join('/'), `confirmed/${shownAmount}/first`);
expectEq('slot', j1.slice(3, 5).join('/'), 'booked/true');
expectEq('payment', j1.slice(5).join('/'), `captured/${shownAmount}/true`);
expectEq('server fee quote', Number(sql(`select public.resolve_fee('${MEERA_DOC}', 'video', 'first')`)), shownAmount);
await until('confirmation message queued for the patient', () => sql(`select count(*) from notifications where user_id = '${USER}' and template_key = 'booking_confirmed' and appointment_id = '${holdId}'`) !== '0');
await p.goto(`${BASE}/p/appointments`);
await p.getByText('Dr. Meera Krishnan').first().waitFor();
ok(`1 book and pay: new patient ${phone} → Dr Meera, ₹${shownAmount} (= server fee) paid by UPI → confirmed; slot booked, payment captured with receipt, confirmation queued`);

// ================================================================ 2. FREE FOLLOW-UP
// a consultation with Dr Meera that finished 3 days ago (inside the 14-day window)
sql(`set app.audit_reason = 'e2e setup';
  with t as (select date_trunc('minute', '2020-01-01 09:00+05:30'::timestamptz + (random() * interval '300 days')) at0),
  s as (insert into slots (doctor_id, start_at, end_at, status) select '${MEERA_DOC}', at0, at0 + interval '15 minutes', 'booked' from t returning id),
  d as (select * from doctors where id = '${MEERA_DOC}'),
  f as (select now() - interval '3 days' - make_interval(mins => n * 20) st from generate_series(0, 500) n   -- first free 15 minutes ~3 days ago
        where not exists (select 1 from appointments x where x.doctor_id = '${MEERA_DOC}' and x.status in ('pending_payment', 'confirmed', 'in_progress', 'completed', 'no_show')
                          and tstzrange(x.start_at, x.end_at) && tstzrange(now() - interval '3 days' - make_interval(mins => n * 20), now() - interval '3 days' - make_interval(mins => n * 20) + interval '15 minutes'))
        order by n limit 1)
  insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status, completed_at, doctor_joined_at, patient_joined_at)
  select 'JRN' || substr(md5(random()::text), 1, 5), '${PT}', '${USER}', d.id, d.hospital_id, d.department_id, s.id,
         f.st, f.st + interval '15 minutes', 'video', 'first', 600, 'completed', f.st + interval '15 minutes', f.st, f.st
  from s, d, f`);
await p.goto(`${BASE}/p`);
const shortcut = p.getByText('Free follow-up with Dr. Meera Krishnan');
await shortcut.waitFor();
await shortcut.click();
await p.getByText('Choose a time').waitFor();
await p.locator('[role="option"]:not([disabled])').nth(4).click();   // a few days out: no clash with booking 1
await p.locator('button[aria-pressed]:not([disabled])').filter({ hasText: /\d:\d\d/ }).first().click();
await p.getByText('Free follow-up', { exact: true }).waitFor();
await p.getByRole('button', { name: 'Continue' }).click();
await p.getByRole('radio', { name: 'Whole body / general' }).click();
await p.getByRole('radio', { name: '1–3 days' }).click();
await p.getByLabel('Describe it in your own words').fill('Fever gone, still tired. Review as advised.');
await p.getByRole('button', { name: 'Continue to review' }).click();
if (await p.getByRole('button', { name: /^Pay ₹/ }).count()) throw new Error('a free follow-up must not ask for payment');
await p.getByRole('button', { name: 'Confirm booking' }).click();
await p.getByRole('heading', { name: 'Booking confirmed' }).waitFor();
await shot(p, 'journey-2-free-follow-up');
const fu = sql(`select a.status || '/' || a.consult_type || '/' || a.fee_amount || '/' || a.is_free || '/' || (select count(*) from payments where appointment_id = a.id)
  from appointments a where a.patient_id = '${PT}' and a.doctor_id = '${MEERA_DOC}' and a.is_free order by a.created_at desc limit 1`);
expectEq('free follow-up booking', fu, 'confirmed/follow_up/0/true/0');
// the policy allows one: the next consultation with Dr Meera is charged again
await p.goto(`${BASE}/p/doctors/${MEERA_DOC}`);
await p.getByText('Choose a time').waitFor();
await p.locator('[role="option"]:not([disabled])').nth(6).click();
await p.locator('button[aria-pressed]:not([disabled])').filter({ hasText: /\d:\d\d/ }).first().click();
// within the window but with the free one used: the (lower) paid follow-up fee, never free
const paidFu = p.getByText(/^Follow-up fee: ₹\d+/);
await paidFu.waitFor();
expectEq('paid follow-up fee = server fee', rupeesOf(await paidFu.textContent()), Number(sql(`select public.resolve_fee('${MEERA_DOC}', 'video', 'follow_up')`)));
if (await p.getByText('Free follow-up', { exact: true }).count()) throw new Error('second follow-up must not be free');
if (await p.getByText('Free follow-up with Dr. Meera Krishnan').count()) throw new Error('shortcut must disappear once used');
ok(`2 free follow-up: offered on home after a completed consult → booked at ₹0, no payment (${fu}); the next one with the same doctor is a paid follow-up at the server's fee`);

// ================================================================ 3. DOCTOR SAME-DAY RESCHEDULE   + 4. DOCTOR CANCELS WITH REFUND
sql(`set app.audit_reason = 'e2e setup'; select expire_reschedule_requests();`);
const slots = sql(`with d as (select (start_at at time zone 'Asia/Kolkata')::date d from slots where doctor_id = '${ARUN_DOC}' and status = 'open' and start_at > now() + interval '2 hours'
                              group by 1 having count(*) >= 4 order by 1 limit 1)
  select id || '|' || start_at from slots, d where doctor_id = '${ARUN_DOC}' and status = 'open' and start_at > now() + interval '2 hours'
    and (start_at at time zone 'Asia/Kolkata')::date = d.d order by start_at limit 4`).split('\n').map((l) => l.split('|'));
if (slots.length < 4) throw new Error('need a day with 4 open slots for Dr Arun');
const book = (slotId, fee = 800) => sql(`set app.audit_reason = 'e2e setup';
  with s as (select * from slots where id = '${slotId}'), d as (select * from doctors where id = '${ARUN_DOC}'),
  a as (insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status)
        select 'JRN' || substr(md5(random()::text), 1, 5), '${PT}', '${USER}', d.id, d.hospital_id, d.department_id, s.id, s.start_at, s.end_at, 'video', 'first', ${fee}, 'confirmed' from s, d returning id, slot_id),
  u as (update slots set status = 'booked', appointment_id = (select id from a) where id = (select slot_id from a)),
  y as (insert into appointment_symptoms (appointment_id, body_area, symptoms, duration, severity, description) select id, 'head', '{headache}', 'today', 4, 'Headache since morning.' from a),
  p as (insert into payments (appointment_id, provider, provider_order_id, provider_payment_id, amount, status, captured_at, method)
        select id, 'mock', 'order_jrn_' || id, 'pay_mock_upi_${fee * 100}_jrn' || substr(md5(random()::text), 1, 8), ${fee}, 'captured', now(), 'upi' from a)
  select id from a`);
const r3 = book(slots[0][0]);
const r4 = book(slots[3][0]);
const [ref3, ref4] = [r3, r4].map((id) => sql(`select ref_code from appointments where id = '${id}'`));

const d = await newPage({ width: 1280, height: 900 });
await otpLogin(d, '9847100001');
await p.goto(`${BASE}/p/appointments`);
await p.locator('[data-live="live"]').waitFor();

await d.goto(`${BASE}/d/appointments/${r3}`);
await d.getByRole('heading', { name: 'Journey Tester' }).waitFor();
await d.getByRole('button', { name: 'Propose another time today' }).click();
await d.getByRole('dialog').getByRole('radio', { name: timeLabel(slots[1][1]) }).click();
await d.getByLabel('Message for the patient').fill('Theatre list ran over');
await d.getByRole('button', { name: 'Send proposal' }).click();
await d.getByText('Proposal sent to the patient').waitFor();
const card = p.locator(`[data-testid="proposal-card"][data-ref="${ref3}"]`);
await card.waitFor({ timeout: 15_000 });   // live (Realtime) – the patient page is not reloaded
await card.getByText('“Theatre list ran over”').waitFor();
await shot(p, 'journey-3-proposal');
await card.getByRole('button', { name: /^Accept/ }).click();
await p.getByText('Done – your consultation has been moved').waitFor();
await d.getByRole('link', { name: /This booking was moved/ }).waitFor({ timeout: 15_000 });
const mv = sql(`select o.status || '/' || n.status || '/' || (n.slot_id = '${slots[1][0]}') || '/' || (select count(*) from payments where appointment_id = n.id) || '/' || (select count(*) from payments where appointment_id = o.id)
  || '/' || (select status from slots where id = '${slots[0][0]}') || '/' || (select status from slots where id = '${slots[1][0]}')
  from appointments o join appointments n on n.id = o.rescheduled_to_id where o.id = '${r3}'`);
expectEq('after the move (old/new/slot/payment new/payment old/old slot/new slot)', mv, 'rescheduled/confirmed/true/1/0/open/booked');
await until('patient told about the proposal and the move', () => sql(`select string_agg(distinct template_key, ',' order by template_key) from notifications where user_id = '${USER}' and template_key in ('reschedule_proposed', 'rescheduled')`) === 'reschedule_proposed,rescheduled');
ok(`3 same-day reschedule: doctor proposed ${sql(`select to_char('${slots[1][1]}'::timestamptz at time zone 'Asia/Kolkata', 'HH12:MI am')`)} → patient saw it live → accepted → moved with its payment, old slot reopened, both messages sent`);

await d.goto(`${BASE}/d/appointments/${r4}`);
await d.getByRole('heading', { name: 'Journey Tester' }).waitFor();
await d.getByRole('button', { name: "I can't take this consultation" }).click();
await d.getByRole('dialog').getByLabel('Note (required)').fill('Called in for an emergency');
await d.getByRole('dialog').getByRole('button', { name: "I can't take this consultation" }).click();
await d.getByText('Booking cancelled – the patient has been told').waitFor();
const fb = p.locator(`[data-testid="fallback-card"][data-ref="${ref4}"]`);
await fb.waitFor({ timeout: 15_000 });
await shot(p, 'journey-4-doctor-cancelled');
await fb.getByRole('button', { name: /^Full refund \(₹800\)/ }).click();
await p.getByText('Cancelled – your refund is on its way').waitFor();
await until('refund processed', () => sql(`select status from refunds where appointment_id = '${r4}'`) === 'processed');
const rf = sql(`select a.status || '/' || a.outcome || '/' || r.amount || '/' || pay.status || '/' || (r.amount = pay.amount)
  from appointments a join refunds r on r.appointment_id = a.id join payments pay on pay.appointment_id = a.id where a.id = '${r4}'`);
expectEq('after the refund (status/outcome/refund/payment/full)', rf, 'cancelled/cancelled_by_doctor/800/refunded/true');
if (await fb.count()) await fb.waitFor({ state: 'detached', timeout: 10_000 });
await until('patient told about the cancellation and the refund', () => sql(`select count(distinct template_key) from notifications where user_id = '${USER}' and appointment_id = '${r4}' and template_key in ('doctor_unavailable', 'refund_initiated', 'refund_processed')`) >= '2');
ok(`4 doctor cancels: patient saw the choice live → full refund ₹800 processed, payment marked refunded, choice card gone, patient told (${rf})`);

// ================================================================ 5. PRESCRIPTION: rule block → sign → final
sql(`set app.audit_reason = 'e2e setup';
  update doctor_secrets set pin_hash = crypt('482916', gen_salt('bf')), failed_attempts = 0, locked_until = null where profile_id = '${ARUN}';`);
const rxAppt = sql(`set app.audit_reason = 'e2e setup';
  with t as (select date_trunc('minute', '2020-01-01 09:00+05:30'::timestamptz + (random() * interval '300 days')) at0),
  s as (insert into slots (doctor_id, start_at, end_at, status) select '${ARUN_DOC}', at0, at0 + interval '15 minutes', 'booked' from t returning id),
  d as (select * from doctors where id = '${ARUN_DOC}'),
  a as (insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status, doctor_joined_at, patient_joined_at)
        select 'JRN' || substr(md5(random()::text), 1, 5), '${PT}', '${USER}', d.id, d.hospital_id, d.department_id, s.id, f.st, f.st + interval '1 minute', 'audio', 'first', 600, 'in_progress', f.st, f.st
        from s, d, (select now() - make_interval(mins => n) st from generate_series(15, 900) n
                    where not exists (select 1 from appointments x where x.doctor_id = '${ARUN_DOC}' and x.status in ('pending_payment', 'confirmed', 'in_progress', 'completed', 'no_show')
                                      and tstzrange(x.start_at, x.end_at) && tstzrange(now() - make_interval(mins => n), now() - make_interval(mins => n) + interval '1 minute'))
                    order by n limit 1) f returning id),
  y as (insert into appointment_symptoms (appointment_id, body_area, symptoms, duration, severity, description) select id, 'throat', '{fever,sore_throat}', '1_3_days', 5, 'Fever and sore throat for two days.' from a)
  select id from a`);

// a signature on file (drawn and saved with the PIN), as a doctor sets it up once
await d.goto(`${BASE}/d/profile/signature`);
const pad = d.locator('[data-ref="sig-pad"]');
await pad.waitFor();
const box = await pad.boundingBox();
await d.mouse.move(box.x + 30, box.y + 90);
await d.mouse.down();
for (let i = 0; i <= 40; i++) await d.mouse.move(box.x + 30 + i * 9, box.y + 75 + Math.sin(i / 3) * 35, { steps: 2 });
await d.mouse.up();
await d.locator('#sig-pin').fill('482916');
await d.locator('[data-ref="sig-save"]').click();
await d.getByText('Signature saved').waitFor();

await d.goto(`${BASE}/d/appointments/${rxAppt}`);
await d.locator('[data-ref="write-link"]').click();
await d.getByRole('heading', { name: 'Journey Tester' }).waitFor();
await d.locator('[data-ref="note-chief_complaint"]').fill('Fever and sore throat');
const dx = d.getByRole('combobox', { name: 'Diagnosis (ICD-10)' });
await dx.fill('tonsil');
await d.getByRole('option', { name: /J03\.9/ }).click();
await d.locator('[data-ref="notes-state"]').filter({ hasText: /^Saved / }).waitFor();

const search = d.locator('[data-ref="drug-search"]');
await search.fill('amoxicillin');
const amox = d.locator('[data-ref="drug-hit"]').filter({ hasText: /^Amoxicillin 500/ }).first();
await amox.getByText("List A isn't allowed in this consultation (audio, first consultation): the first prescription needs a video consultation.", { exact: false }).waitFor();
if (!(await amox.getByRole('button', { name: 'Add Amoxicillin' }).isDisabled())) throw new Error('List A must be blocked in an audio first consult');
await search.fill('alprazolam');
await d.locator('[data-ref="drug-hit"]').filter({ hasText: 'Alprazolam' }).getByText(/Prohibited list: can't be prescribed by teleconsultation/).waitFor();
await shot(d, 'journey-5-blocked');
const arun = createClient(API, keys.ANON_KEY, { auth: { persistSession: false } });
await arun.auth.signInWithOtp({ phone: '+919847100001' });
await arun.auth.verifyOtp({ phone: '+919847100001', token: '123456', type: 'sms' });
const amoxId = sql(`select id from drug_master where name = 'Amoxicillin' limit 1`);
const viaApi = await arun.rpc('save_rx_draft', { p_appt: rxAppt, p_items: [{ drug_id: amoxId }] });
expectEq('API refuses the blocked drug', viaApi.error?.message, 'drug_blocked');

await search.fill('paracetamol 650');
await d.getByRole('button', { name: 'Add Paracetamol 650', exact: true }).click();
const item = d.locator('[data-ref="rx-item"]').filter({ hasText: /^\s*\d+\.\s*Paracetamol 650/ });
await item.waitFor();
await item.getByLabel('Duration').fill('3 days');
await d.locator('[data-ref="rx-state"]').filter({ hasText: 'Saved' }).waitFor();
await d.locator('[data-ref="rx-sign"]').click();
const sign = d.getByRole('dialog');
await sign.getByLabel('Signing PIN').fill('482916');
await sign.locator('[data-ref="sign-confirm"]').click();
await d.locator('[data-ref="rx-final"]').waitFor();
await shot(d, 'journey-5-signed');
const rx = sql(`select r.id || '|' || r.rx_no || '|' || r.verification_code || '|' || r.status || '|' || (select string_agg(drug_name, ',') from prescription_items where prescription_id = r.id)
  || '|' || (select status from consultations where appointment_id = r.appointment_id) from prescriptions r where r.appointment_id = '${rxAppt}'`).split('|');
if (!/^SCRX-\d{4}-\d{6}$/.test(rx[1])) throw new Error(`rx number: ${rx[1]}`);
expectEq('prescription (status/items/notes)', `${rx[3]}/${rx[4]}/${rx[5]}`, 'final/Paracetamol 650/final');
await until('PDF stored at signing', () => sql(`select pdf_path is not null from prescriptions where id = '${rx[0]}'`) === 't');
const lockedEdit = await arun.rpc('save_rx_draft', { p_appt: rxAppt, p_items: [] });
if (!lockedEdit.error) throw new Error('a signed prescription must be locked');

await p.goto(`${BASE}/p/records/${rx[0]}`);
await p.getByText(rx[1]).first().waitFor();
await p.getByText('Paracetamol 650').first().waitFor();
await shot(p, 'journey-5-patient-record');
const pub = await newPage({ width: 390, height: 844 });
await pub.goto(`${BASE}/verify/${rx[2]}`);
await pub.getByText('Valid prescription').waitFor();
await pub.getByText('Dr. Arun Nair').waitFor();
if (await pub.getByText('Journey Tester').count()) throw new Error('the public check must not show the patient');
ok(`5 prescription: List A + Prohibited blocked with reasons (UI and API: drug_blocked) → Paracetamol signed with the PIN → ${rx[1]} final, notes locked, PDF stored, edits refused; patient sees it; public QR check valid without the patient's name`);

await browser.close();
if (errors.length) {
  console.error('✗ console errors:\n' + [...new Set(errors)].join('\n'));
  process.exit(1);
}
console.log('\ncritical journeys: all 5 passed');
