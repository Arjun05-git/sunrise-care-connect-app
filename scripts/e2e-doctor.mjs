/**
 * Doctor experience end to end, doctor and patient in two browsers at once (real stack + Realtime):
 *   Today dashboard · appointment detail (symptoms, red flags, allergies, document viewer) ·
 *   same-day reschedule → patient sees it LIVE → accepts → doctor sees the move LIVE ·
 *   second proposal → patient declines with refund · "can't take this consult" → patient picks a free new time ·
 *   outcome marking · availability (leave + validation) · calendar · patients + audited timeline.
 *
 *   npm run stack:up && npm run dev   then   PGHOST=… PGPORT=… PGUSER=postgres node scripts/e2e-doctor.mjs http://localhost:5173
 */
import { chromium } from 'playwright-core';
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const API = process.env.SUPABASE_LOCAL_URL ?? 'http://127.0.0.1:54321';
const OUT = process.argv[3] ?? 'docs/screenshots';
const DB = process.env.STACK_DB ?? 'sunrise_local';
mkdirSync(OUT, { recursive: true });
const sql = (q) => execFileSync('psql', ['-X', '-At', '-q', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const keys = Object.fromEntries(readFileSync('.local-stack/keys.env', 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
const ok = (s) => console.log('✓', s);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const errors = [];
const pages = [];
process.on('uncaughtException', async (e) => {
  console.error('✗', e.message.split('\n')[0]);
  for (const [i, pg] of pages.entries()) await pg.screenshot({ path: `${OUT}/fail-${i}.png`, fullPage: true }).catch(() => {});
  if (errors.length) console.error('console errors:\n' + [...new Set(errors)].join('\n'));
  process.exit(1);
});
async function newPage(viewport) {
  const page = await (await browser.newContext({ viewport })).newPage();
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
}
const timeLabel = (iso) => new RegExp(`^${sql(`select to_char('${iso}'::timestamptz at time zone 'Asia/Kolkata', 'FMHH12:MI')`)} [ap]m$`, 'i');

// ---------------------------------------------------------------- data: bookings for Dr Arun with Anjali (+ a dependent)
const A = '00000004-0000-4000-8000-000000000001';
const PT = '00000005-0000-4000-8000-000000000001';
sql(`set app.audit_reason = 'e2e setup'; select expire_reschedule_requests();`);
// first day with ≥ 4 open slots starting ≥ 2 h from now
const slots = sql(`with d as (select (start_at at time zone 'Asia/Kolkata')::date d from slots where doctor_id = '${A}' and status = 'open' and start_at > now() + interval '2 hours' group by 1 having count(*) >= 4 order by 1 limit 1)
  select id || '|' || start_at from slots, d where doctor_id = '${A}' and status = 'open' and start_at > now() + interval '2 hours' and (start_at at time zone 'Asia/Kolkata')::date = d.d order by start_at limit 4`).split('\n').map((l) => l.split('|'));
const book = (slotId, patient = PT, fee = 800) => sql(`set app.audit_reason = 'e2e setup';
  with s as (select * from slots where id = '${slotId}'), d as (select * from doctors where id = '${A}'),
  a as (insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status)
        select 'E2E' || substr(md5(random()::text), 1, 5), '${patient}', '00000001-0000-4000-8000-0000000000c8', d.id, d.hospital_id, d.department_id, s.id, s.start_at, s.end_at, 'video', 'first', ${fee}, 'confirmed' from s, d returning id, slot_id),
  u as (update slots set status = 'booked', appointment_id = (select id from a) where id = (select slot_id from a)),
  y as (insert into appointment_symptoms (appointment_id, body_area, symptoms, duration, severity, description, vitals, allergies)
        select id, 'chest', '{chest_pain,palpitations}', '1_3_days', 7, 'Chest tightness on climbing stairs since two days.', '{"bp":"150/95","pulse":"104"}', 'Sulfa drugs' from a),
  p as (insert into payments (appointment_id, provider, provider_order_id, provider_payment_id, amount, status, captured_at, method)
        select id, 'mock', 'order_e2e_' || id, 'pay_mock_upi_${fee * 100}_e2e' || substr(md5(random()::text), 1, 8), ${fee}, 'captured', now(), 'upi' from a)
  select id from a`);
const b1 = book(slots[0][0]);
const b3 = book(slots[2][0]);
// a consult that started ≥ 11 minutes ago with both in the room (for outcomes; otherwise the no-show sweep takes it): 2020 slot, appointment moved to "now"
const b2 = sql(`set app.audit_reason = 'e2e setup';
  with t as (select date_trunc('minute', '2020-01-01 09:00+05:30'::timestamptz + (random() * interval '300 days')) at0),
  s as (insert into slots (doctor_id, start_at, end_at, status) select '${A}', at0, at0 + interval '15 minutes', 'booked' from t on conflict do nothing returning id)
  select id from s`);
const b2appt = sql(`set app.audit_reason = 'e2e setup';
  with d as (select * from doctors where id = '${A}'),
  a as (insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status, doctor_joined_at, patient_joined_at)
        select 'E2E' || substr(md5(random()::text), 1, 5), '${PT}', '00000001-0000-4000-8000-0000000000c8', d.id, d.hospital_id, d.department_id, '${b2}', f.st, f.st + interval '1 minute', 'audio', 'first', 0, 'confirmed', f.st, f.st
        from d, (select now() - make_interval(mins => n) st from generate_series(11, 600) n   -- first free minute ≥ 11 min ago (past the grace period)
                 where not exists (select 1 from appointments x where x.doctor_id = '${A}' and x.status in ('pending_payment', 'confirmed', 'in_progress', 'completed', 'no_show')
                                   and tstzrange(x.start_at, x.end_at) && tstzrange(now() - make_interval(mins => n), now() - make_interval(mins => n) + interval '1 minute'))
                 order by n limit 1) f returning id)
  select id from a`);

// a document on b1, uploaded by the patient through the real storage API
const anjali = createClient(API, keys.ANON_KEY, { auth: { persistSession: false } });
await anjali.auth.signInWithOtp({ phone: '+919847000001' });
await anjali.auth.verifyOtp({ phone: '+919847000001', token: '123456', type: 'sms' });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const docId = crypto.randomUUID();
const path = `patients/${PT}/${docId}.png`;
const up = await anjali.storage.from('medical-documents').upload(path, png, { contentType: 'image/png' });
if (up.error) throw new Error(`upload: ${up.error.message}`);
// registered the way the app does it: documents-register reads the file back and checks its bytes
const ins = await anjali.functions.invoke('documents-register', { body: { document_id: docId, patient_id: PT, ext: 'png', tag: 'lab_report', file_name: 'ecg-report.png' } });
if (ins.error) throw new Error(`doc row: ${ins.error.message}`);
sql(`update documents set appointment_id = '${b1}' where id = '${docId}'`);   // as the booking's hold does
ok('setup: 3 bookings with Dr Arun for Anjali, one started ≥ 11 min ago; ECG image uploaded by the patient');

// ---------------------------------------------------------------- 1. doctor: Today + appointment detail
const d = await newPage({ width: 1280, height: 900 });
await otpLogin(d, '9847100001');
await d.getByRole('heading', { name: 'Dr. Arun Nair' }).waitFor();
await d.locator('[data-live="live"]').waitFor();
await d.getByText("Today's schedule").waitFor();
await shot(d, 'doctor-today');
ok('Today: dashboard with stats, schedule and Live indicator');

await d.goto(`${BASE}/d/appointments/${b1}`);
await d.getByRole('heading', { name: 'Anjali Menon' }).waitFor();
await d.getByText(/Red-flag symptoms: Chest pain, Racing heartbeat/).waitFor();
await d.getByRole('note').filter({ hasText: 'Sulfa drugs' }).waitFor();
await d.getByText('150/95').waitFor();
await d.getByRole('button', { name: 'Preview ecg-report.png' }).click();
await d.getByRole('dialog').getByRole('img', { name: 'ecg-report.png' }).waitFor();
await shot(d, 'doctor-document-viewer');
await d.keyboard.press('Escape');
await d.locator('[data-live="live"]').waitFor();
ok('appointment: symptoms, red flags, allergies, vitals; document opened in the viewer (signed URL)');

// ---------------------------------------------------------------- 2. live reschedule: propose → patient sees it → accepts → doctor sees it
const p = await newPage({ width: 390, height: 844 });
await otpLogin(p, '9847000001');
await p.getByRole('heading', { name: /Hello/ }).waitFor();
await p.goto(`${BASE}/p/appointments`);
await p.locator('[data-live="live"]').waitFor();
const ref1 = sql(`select ref_code from appointments where id = '${b1}'`);
const ref3 = sql(`select ref_code from appointments where id = '${b3}'`);
if (await p.locator(`[data-ref="${ref1}"]`).count()) throw new Error('no proposal expected yet');

await d.getByRole('button', { name: 'Propose another time today' }).click();
await d.getByRole('dialog').getByRole('radio', { name: timeLabel(slots[1][1]) }).click();
await d.getByLabel('Message for the patient').fill('An emergency surgery ran late');
await d.getByRole('button', { name: 'Send proposal' }).click();
await d.getByText('Proposal sent to the patient').waitFor();
await d.getByText(/Patient must answer by/).first().waitFor();

const card = p.locator(`[data-testid="proposal-card"][data-ref="${ref1}"]`);
await card.waitFor({ timeout: 10_000 }); // arrives via Realtime – the patient page was not reloaded
await card.getByText('“An emergency surgery ran late”').waitFor();
await shot(p, 'patient-reschedule-proposal');
ok('doctor proposed a same-day time → patient saw it live (no reload)');

await card.getByRole('button', { name: /^Accept/ }).click();
await p.getByText('Done – your consultation has been moved').waitFor();
await d.getByRole('link', { name: /This booking was moved/ }).waitFor({ timeout: 10_000 }); // doctor page updates live too
const moved = sql(`select o.status || '/' || n.status || '/' || (n.slot_id = '${slots[1][0]}') || '/' || (select count(*) from payments where appointment_id = n.id) from appointments o join appointments n on n.id = o.rescheduled_to_id where o.id = '${b1}'`);
if (moved !== 'rescheduled/confirmed/true/1') throw new Error(`after accept: ${moved}`);
await shot(d, 'doctor-moved-live');
ok('patient accepted → doctor saw the move live; booking moved with its payment');

// ---------------------------------------------------------------- 3. second proposal → decline with refund
await d.getByRole('link', { name: /This booking was moved/ }).click();
await d.getByRole('button', { name: 'Propose another time today' }).click();
await d.getByRole('dialog').getByRole('radio', { name: timeLabel(slots[0][1]) }).click();
await d.getByLabel('Message for the patient').fill('Clinic schedule change');
await d.getByRole('button', { name: 'Send proposal' }).click();
await card.waitFor({ timeout: 10_000 });
await card.getByRole('button', { name: 'Decline' }).click();
await p.getByRole('dialog').getByRole('button', { name: /Cancel and get a full refund/ }).click();
await p.getByText('Cancelled – your refund is on its way').waitFor();
await d.getByText('Cancelled by doctor').first().waitFor({ timeout: 10_000 });
const nb1 = sql(`select rescheduled_to_id from appointments where id = '${b1}'`);
const refund = sql(`select r.status || '/' || r.amount from refunds r where r.appointment_id = '${nb1}'`);
if (refund !== 'processed/800') throw new Error(`refund: ${refund}`);
ok('second proposal declined with refund → booking cancelled, ₹800 refunded, doctor updated live');

// ---------------------------------------------------------------- 4. doctor can't attend → patient picks a free new time
await d.goto(`${BASE}/d/appointments/${b3}`);
await d.getByRole('button', { name: "I can't take this consultation" }).click();
await d.getByRole('dialog').getByLabel('Note (required)').fill('Called in for an emergency');
await d.getByRole('dialog').getByRole('button', { name: "I can't take this consultation" }).click();
await d.getByText('Booking cancelled – the patient has been told').waitFor();
const fb = p.locator(`[data-testid="fallback-card"][data-ref="${ref3}"]`);
await fb.waitFor({ timeout: 10_000 });
await fb.getByRole('button', { name: 'Choose a new time (free)' }).click();
await p.getByRole('heading', { name: 'Choose a new time' }).waitFor();
await p.locator('button[aria-pressed]:not([disabled])').filter({ hasText: /\d:\d\d/ }).first().click();
await p.getByRole('button', { name: 'Confirm new time' }).click();
await p.getByText(/^Booked for /).waitFor();
const nb3 = sql(`select n.status || '/' || (select count(*) from payments where appointment_id = n.id) from appointments o join appointments n on n.id = o.rescheduled_to_id where o.id = '${b3}'`);
if (nb3 !== 'confirmed/1') throw new Error(`fallback reschedule: ${nb3}`);
await shot(p, 'patient-appointments');
ok("doctor couldn't attend → patient chose a free new time (no payment, original payment carried over)");

// ---------------------------------------------------------------- 5. outcome
await d.goto(`${BASE}/d/appointments/${b2appt}`);
await d.getByRole('button', { name: "Patient didn't join" }).waitFor();
await d.getByRole('button', { name: 'Mark completed' }).click();
await d.getByText('Marked as completed').waitFor();
await d.getByText('Completed', { exact: true }).first().waitFor();
if (sql(`select status from appointments where id = '${b2appt}'`) !== 'completed') throw new Error('outcome');
ok('outcome: started consultation marked completed');

// ---------------------------------------------------------------- 6. availability + calendar
await d.goto(`${BASE}/d/availability`);
await d.getByRole('heading', { name: 'Weekly hours' }).waitFor();
await d.getByRole('button', { name: 'Add hours' }).first().click();
const firstFrom = d.getByLabel('Monday from');
await firstFrom.last().fill('08:00');
await d.getByText('Ranges overlap.').waitFor();
if (!(await d.getByRole('button', { name: 'Save weekly hours' }).isDisabled())) throw new Error('save must be disabled with overlapping ranges');
await d.getByRole('button', { name: 'Cancel' }).click();
const leaveDay = sql(`select ((now() at time zone 'Asia/Kolkata')::date + 12)::text`);
await d.getByLabel('From', { exact: true }).fill(leaveDay);
await d.getByLabel('To', { exact: true }).fill(leaveDay);
await d.getByLabel('Note (only you and admins see it)').fill('Medical conference');
await d.getByRole('button', { name: 'Add leave' }).click();
await d.getByText(/Leave added|outside your hours/).first().waitFor();
await shot(d, 'doctor-availability');
await d.goto(`${BASE}/d/calendar`);
await d.getByRole('button', { name: 'Next week' }).click();
await d.getByRole('button', { name: 'Next week' }).click();
await shot(d, 'doctor-calendar');
await d.goto(`${BASE}/d/availability`);
await d.getByRole('button', { name: 'Remove leave' }).first().click();
await d.getByText('Leave removed – slots reopened').waitFor();
ok('availability: overlap validation, leave added (slots removed) and removed; calendar week view');

// ---------------------------------------------------------------- 7. patients + timeline (audited)
await d.goto(`${BASE}/d/patients`);
await d.getByLabel('Search by name or MRN').fill('Anjali');
await d.getByRole('link', { name: /Anjali Menon/ }).click();
await d.getByRole('heading', { name: 'History' }).waitFor();
await d.getByText('Access to this record is logged for patient privacy.').waitFor();
await shot(d, 'doctor-timeline');
if (Number(sql(`select count(*) from audit_logs where action = 'patient.view_history' and entity_id = '${PT}' and created_at > now() - interval '5 minutes'`)) < 1) throw new Error('timeline view not audited');
ok('patients list → timeline (consults, prescriptions, documents); view audited');

// ---------------------------------------------------------------- 8. doctor on a phone, Malayalam
const m = await newPage({ width: 390, height: 844 });
await otpLogin(m, '9847100001');
await m.getByText("Today's schedule").waitFor();
await m.evaluate(() => localStorage.setItem('scc-prefs', JSON.stringify({ theme: 'light', fontScale: 1, language: 'ml' })));
await m.reload();
await m.getByText('ഇന്നത്തെ ഷെഡ്യൂൾ').waitFor();
await shot(m, 'doctor-today-mobile-ml');
ok('doctor Today on a phone in Malayalam');

await browser.close();
if (errors.length) {
  console.error('✗ console errors:\n' + [...new Set(errors)].join('\n'));
  process.exit(1);
}
console.log('\nall doctor e2e checks passed');
