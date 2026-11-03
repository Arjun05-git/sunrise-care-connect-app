/**
 * Admin console end to end (real stack):
 *   dashboard (KPIs, charts with table view) · coordinator onboards a doctor (profile → phone login →
 *   certificate upload → submit) · a second person (admin) verifies with a note · the new doctor signs in ·
 *   suspension cancels future bookings, reinstating needs verification again · appointment monitor:
 *   "needs a person" → extend the room → record doctor no-show; move to another time; cancel with the
 *   policy refund · masters: ICD-10 code, holiday · content: wording fix shows on the public legal page;
 *   a new consent version makes the patient accept again · users: staff invite link → set password →
 *   sign in → roles removed · support: patient ticket ↔ staff reply (internal note hidden) → resolved ·
 *   audit search · reports + CSV (no patient identity).
 *
 *   npm run stack:up && npm run dev   then   PGHOST=… PGPORT=… PGUSER=postgres node scripts/e2e-admin.mjs http://localhost:5173
 */
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = process.argv[3] ?? 'docs/screenshots';
const DB = process.env.STACK_DB ?? 'sunrise_local';
const TMP = '.local-stack';
mkdirSync(OUT, { recursive: true });
const sql = (q) => execFileSync('psql', ['-X', '-At', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const ok = (s) => console.log('✓', s);
const RUN = Math.random().toString(36).slice(2, 7).toUpperCase();

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const errors = [];
const pages = [];
const cleanup = [];
async function fail(e) {
  console.error('✗', (e?.message ?? String(e)).split('\n')[0]);
  for (const [i, pg] of pages.entries()) await pg.screenshot({ path: `${OUT}/fail-admin-${i}.png`, fullPage: true }).catch(() => {});
  if (errors.length) console.error('console errors:\n' + [...new Set(errors)].join('\n'));
  for (const q of cleanup.reverse()) try { sql(q); } catch { /* best effort */ }
  process.exit(1);
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
async function newPage(viewport = { width: 1366, height: 900 }) {
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
async function otpLogin(page, phone, role = 'Patient') {
  await page.goto(`${BASE}/login`);
  if (role === 'Doctor') await page.getByRole('tab', { name: 'Doctor' }).click();
  const form = page.getByRole('tabpanel');
  await form.getByLabel('Mobile number').fill(phone);
  await form.getByRole('button', { name: 'Get OTP' }).click();
  await page.getByLabel('One-time password digit 1').fill('123456');
  await page.getByRole('button', { name: 'Verify & continue' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}
async function staffLogin(page, email, password = 'Sunrise@123') {
  await page.goto(`${BASE}/login`);
  await page.getByRole('tab', { name: 'Staff' }).click();
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
}
/** Fill the mandatory reason in the open dialog and press its confirm button. */
async function reason(page, text, confirm) {
  const dlg = page.getByRole('dialog').last();
  await dlg.getByLabel('Reason for this change').fill(text);
  await dlg.getByRole('button', { name: confirm, exact: true }).click();
}
async function pick(page, triggerSel, option) {
  await page.locator(triggerSel).click();
  await page.getByRole('option', { name: option, exact: true }).first().click();
}

const ADMIN = sql(`select id from profiles where email = 'admin@sunrise.demo'`);
const COORD = sql(`select id from profiles where email = 'coordinator@sunrise.demo'`);
const ARUN = '00000004-0000-4000-8000-000000000001';
const SHABNA_PT = '00000005-0000-4000-8000-000000000003';
const SHABNA = '00000001-0000-4000-8000-0000000000ca';
// a sign-up number from the local OTP test map that no account uses yet
const free = sql(`select n from generate_series(0, 19) i, lateral (select '+9198479990' || lpad(i::text, 2, '0') n) x where not exists (select 1 from profiles where phone = x.n) and not exists (select 1 from doctors where phone = x.n) limit 1`);
if (!free) throw new Error('no free test phone number left (+919847999000–19)');
const DOC_PHONE = free;
// repeated runs would hit the patient's ticket limit (5 an hour) – start each run with a clean counter
sql(`delete from rate_limits where key in ('ticket:${SHABNA}', 'ticketmsg:${SHABNA}')`);

// booking helper: a free 1-minute window for doctor p_doc around p_expr
const book = (doctor, patient, owner, status, startExpr, paid = 0) => sql(`set app.audit_reason = 'e2e setup';
  with t as (select date_trunc('minute', '2020-01-01 09:00+05:30'::timestamptz + (random() * interval '300 days')) at0),
  s as (insert into slots (doctor_id, start_at, end_at, status) select '${doctor}', at0, at0 + interval '15 minutes', 'booked' from t returning id),
  d as (select * from doctors where id = '${doctor}'),
  a as (insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status)
        select 'ADM' || substr(md5(random()::text), 1, 5), '${patient}', '${owner}', d.id, d.hospital_id, d.department_id, s.id, f.st, f.st + interval '15 minutes', 'video', 'first', 800, '${status}'
        from s, d, (select ${startExpr} st from generate_series(1, 400) n
                    where not exists (select 1 from appointments x where x.doctor_id = '${doctor}' and x.status in ('pending_payment', 'confirmed', 'in_progress', 'completed', 'no_show')
                                      and tstzrange(x.start_at, x.end_at + interval '1 minute') && tstzrange(${startExpr}, ${startExpr} + interval '16 minutes'))
                      and not exists (select 1 from appointments x where x.patient_id = '${patient}' and x.status in ('pending_payment', 'confirmed', 'in_progress')
                                      and tstzrange(x.start_at, x.end_at) && tstzrange(${startExpr}, ${startExpr} + interval '15 minutes'))
                    order by n limit 1) f returning id),
  p as (insert into payments (appointment_id, provider, provider_order_id, provider_payment_id, amount, status, captured_at)
        select id, 'mock', 'order_e2e_' || id, 'pay_e2e_' || id, ${paid}, 'captured', now() from a where ${paid} > 0)
  select id from a`);

// ---------------------------------------------------------------- 1. dashboard
const a = await newPage();
await staffLogin(a, 'admin@sunrise.demo');
await a.locator('[data-ref="kpis"]').waitFor();
await a.locator('svg[role="group"]').first().waitFor();
const col = a.locator('svg[role="group"] g[role="list"] > g[role="listitem"]').last();
await col.hover();
await a.getByRole('tooltip').waitFor();
await a.getByRole('button', { name: 'Table' }).first().click();
await a.getByRole('columnheader', { name: 'Completed' }).first().waitFor();
await a.getByRole('button', { name: 'Chart' }).first().click();
await shot(a, 'admin-dashboard');
ok('dashboard: KPIs, "needs attention" links, charts with hover tooltip and a table view');

// ---------------------------------------------------------------- 2. onboarding by a coordinator
const c = await newPage();
await staffLogin(c, 'coordinator@sunrise.demo');
await c.goto(`${BASE}/a/doctors/new`);
await c.locator('#d-name').fill(`Dr. Onboard ${RUN}`);
await c.locator('#d-phone').fill(DOC_PHONE);
await c.locator('#d-qual').fill('MBBS, MD (General Medicine)');
await c.locator('#d-exp').fill('6');
await c.locator('#d-reg').fill(`TCMC/E2E-${RUN}`);
await pick(c, '#d-hosp', 'Sunrise Hospital Kakkanad');
await pick(c, '#d-dept', 'General Medicine');
await c.locator('[data-ref="doc-save"]').click();
await reason(c, 'New physician joining Kakkanad OPD', 'Save');
await c.waitForURL(/\/a\/doctors\/[0-9a-f-]{36}$/);
const DOC = c.url().split('/').pop();
cleanup.push(`update doctors set verification_status = 'suspended', suspension_reason = 'e2e cleanup' where id = '${DOC}'`);
await c.locator('[data-ref="create-login"]').click();
await c.locator('[data-ref="login-ok"]').waitFor();
const DOC_USER = sql(`select profile_id from doctors where id = '${DOC}'`);
// give the test phone number back (the local OTP map has only 20 sign-up numbers); the record stays, suspended
cleanup.push(`set app.audit_reason = 'e2e cleanup'; update doctors set profile_id = null, phone = '+910000000000' where id = '${DOC}'; delete from auth.users where id = '${DOC_USER}'`);
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
await c.locator('[data-ref="cred-file"]').setInputFiles({ name: `TCMC-certificate-${RUN}.pdf`, mimeType: 'application/pdf', buffer: pdf });
await c.getByText('Document uploaded').waitFor();
await c.locator('[data-ref="credentials"]').getByText('Registration certificate').waitFor();
await c.locator('[data-ref="submit-doc"]').click();
await c.locator('[data-ref="doc-status"]').getByText('Waiting for verification').waitFor();
if (await c.locator('[data-ref="verify-doc"]').count()) throw new Error('coordinator offered Verify');
if (sql(`select count(*) from search_doctors() where id = '${DOC}'`) !== '0') throw new Error('unverified doctor bookable');
await shot(c, 'admin-doctor-pending');
ok(`coordinator onboarded Dr. Onboard ${RUN}: profile, phone login ${DOC_PHONE}, certificate (PDF) uploaded, submitted; not bookable yet`);

// ---------------------------------------------------------------- 3. second person verifies; doctor signs in
await a.goto(`${BASE}/a/doctors/${DOC}`);
await a.locator('[data-ref="verify-doc"]').click();
await a.locator('#v-note').fill(`E2E verification ${RUN}: number found on the TCMC online register, name matches`);
await a.getByRole('dialog').last().getByRole('button', { name: 'Verify', exact: true }).click();
await a.locator('[data-ref="doc-status"]').getByText('Verified').waitFor();
const v = sql(`select verified_by || '/' || onboarded_by || '/' || submitted_by from doctors where id = '${DOC}'`);
if (v !== `${ADMIN}/${COORD}/${COORD}`) throw new Error(`verification people: ${v}`);
await shot(a, 'admin-doctor-verified');
const d = await newPage({ width: 390, height: 844 });
await otpLogin(d, DOC_PHONE.slice(3), 'Doctor');
await d.waitForURL(/\/d$/);
ok('a different person (admin) verified with a note; the new doctor signs in with OTP and reaches Today');

// ---------------------------------------------------------------- 4. suspension and reinstatement
const susp = book(DOC, SHABNA_PT, SHABNA, 'confirmed', `now() + make_interval(days => 3, mins => n * 20)`, 800);
await a.reload();
await a.getByRole('button', { name: 'Suspend' }).click();
await reason(a, 'Registration renewal pending with TCMC', 'Suspend');
await a.locator('[data-ref="doc-status"]').getByText('Suspended').waitFor();
const so = sql(`select status || '/' || outcome from appointments where id = '${susp}'`);
if (so !== 'cancelled/cancelled_by_doctor') throw new Error(`suspension booking: ${so}`);
await a.getByRole('button', { name: 'Reinstate' }).click();
await reason(a, 'Renewal certificate received', 'Reinstate');
await a.locator('[data-ref="doc-status"]').getByText('Waiting for verification').waitFor();
if (await a.locator('[data-ref="verify-doc"]').count()) throw new Error('the reinstating admin was offered Verify');
ok('suspension cancels the future booking for a doctor-side reason (patient chooses); reinstating sends it back for a second person');

// ---------------------------------------------------------------- 5. appointment monitor
const late = book(ARUN, SHABNA_PT, SHABNA, 'confirmed', `now() - make_interval(mins => 15 + n)`);
const fut = book(ARUN, SHABNA_PT, SHABNA, 'confirmed', `now() + make_interval(hours => 26, mins => n * 15)`, 800);
cleanup.push(`set app.audit_reason = 'e2e cleanup'; update appointments set status = 'cancelled', outcome = 'cancelled_by_admin' where id in ('${late}', '${fut}') and status = 'confirmed'`);
const lateRef = sql(`select ref_code from appointments where id = '${late}'`);
const futRef = sql(`select ref_code from appointments where id = '${fut}'`);
await c.goto(`${BASE}/a/appointments?attention=1`);
const lateRow = c.locator('[data-ref="monitor-row"]').filter({ hasText: lateRef });
await lateRow.getByText('Doctor not joined').waitFor();
await shot(c, 'admin-monitor');
await lateRow.click();
await c.locator('[data-ref="act-extend"]').click();
await reason(c, 'Doctor stuck in OPD, joining shortly', 'Extend the room');
await c.getByText('Room extended by 15 minutes').waitFor();
await c.locator('[data-ref="act-outcome"]').click();
await c.getByRole('dialog').last().getByText('Doctor did not join').click();
await reason(c, 'Doctor unreachable; confirmed with OPD desk', 'Record');
await c.getByText('Done', { exact: true }).first().waitFor();
const lo = sql(`select status || '/' || outcome || '/' || extended_minutes from appointments where id = '${late}'`);
if (lo !== 'cancelled/doctor_no_show/15') throw new Error(`late booking: ${lo}`);
await c.keyboard.press('Escape');
ok('monitor: "needs a person" flag → extend the room 15 min → doctor no-show recorded (patient gets free reschedule / refund)');

await c.goto(`${BASE}/a/appointments`);
await c.locator('#m-to').fill(sql(`select to_char((now() at time zone 'Asia/Kolkata')::date + 3, 'YYYY-MM-DD')`));
await c.locator('#m-q').fill(futRef);
await c.locator('[data-ref="monitor-row"]').filter({ hasText: futRef }).click();
await c.locator('[data-ref="act-move"]').click();
await c.getByRole('dialog').last().getByRole('radio').last().click();   // latest free time: > 2 h away, so the policy refund is 100 %
await reason(c, 'Patient asked by phone for another time', 'Move to another time');
await c.getByText('Booking moved').waitFor();
const moved = sql(`select id from appointments where rescheduled_from_id = '${fut}'`);
if (!moved) throw new Error('move did not create the new booking');
cleanup.push(`set app.audit_reason = 'e2e cleanup'; update appointments set status = 'cancelled', outcome = 'cancelled_by_admin' where id = '${moved}' and status = 'confirmed'`);
await c.keyboard.press('Escape');
ok(`monitor: ${futRef} moved to another free time (same reference, payment follows)`);

await a.goto(`${BASE}/a/appointments`);
await a.locator('#m-q').fill(futRef);   // a reference search covers every date
await a.locator('[data-ref="monitor-row"]').filter({ hasText: futRef }).click();
const expected = sql(`select public.refund_quote('${moved}', 'patient') ->> 'amount'`);   // tiers may have been edited by other suites
await a.locator('[data-ref="act-cancel"]').click();
await a.getByRole('dialog').last().getByText('As per the patient cancellation policy').click();
await reason(a, 'Patient cancelled by phone; policy refund', 'Cancel booking');
await a.getByText(/Cancelled\. Refund: ₹/).waitFor();
const cx = sql(`select a.outcome || '/' || (select amount from refunds where appointment_id = a.id) from appointments a where a.id = '${moved}'`);
if (cx !== `cancelled_by_admin/${expected}` && !(expected === '0' && cx === '')) throw new Error(`cancel: ${cx} (expected ${expected})`);
await shot(a, 'admin-monitor-cancelled');
await a.keyboard.press('Escape');
ok(`monitor: admin cancelled with the policy refund (${cx.split('/')[1]} refunded); patient and doctor told`);

// ---------------------------------------------------------------- 6. masters
await a.goto(`${BASE}/a/masters`);
await a.getByRole('tab', { name: 'ICD-10' }).click();
await a.getByRole('button', { name: 'Add ICD-10 code' }).click();
await a.locator('#icd-code').fill('Z99.8');
await a.locator('#icd-desc').fill(`Dependence on other enabling machines (E2E ${RUN})`);
await reason(a, 'Requested by medical records', 'Save');
await a.getByText('Saved', { exact: true }).first().waitFor();
if (!sql(`select description from icd10_master where code = 'Z99.8'`).includes(RUN)) throw new Error('ICD not saved');
await a.getByRole('tab', { name: 'Holidays' }).click();
await a.getByRole('button', { name: 'Add holiday' }).click();
const hday = sql(`select to_char((now() at time zone 'Asia/Kolkata')::date + 60, 'YYYY-MM-DD')`);
await a.locator('#ho-date').fill(hday);
await a.locator('#ho-name').fill(`E2E holiday ${RUN}`);
await reason(a, 'Hospital closed for maintenance', 'Save');
await a.getByText(`E2E holiday ${RUN}`).waitFor();
await a.getByRole('button', { name: `Remove E2E holiday ${RUN}` }).click();
await reason(a, 'Maintenance rescheduled', 'Remove');
await a.getByText(`E2E holiday ${RUN}`).waitFor({ state: 'detached' });
ok('masters: ICD-10 code added (reason, audited); holiday added and removed');

// ---------------------------------------------------------------- 7. content
const before = { versions: sql(`select value::text from app_settings where key = 'consent_versions'`), texts: sql(`select value::text from app_settings where key = 'consent_texts'`) };
cleanup.push(`update app_settings set value = $j$${before.versions}$j$::jsonb where key = 'consent_versions'`);
cleanup.push(`update app_settings set value = $j$${before.texts}$j$::jsonb where key = 'consent_texts'`);
await a.goto(`${BASE}/a/content`);
await a.getByRole('button', { name: /^Privacy Notice/ }).click();
const en = a.locator('#c-en');
await en.fill(`${await en.inputValue()}\nE2E note ${RUN}.`);
await a.locator('[data-ref="publish"]').click();
await reason(a, 'Added contact line', 'Publish');
await a.getByText(/Published v1\.0 \(revision/).waitFor();
const pub = await newPage({ width: 390, height: 844 });
await pub.goto(`${BASE}/legal/privacy_notice`);
await pub.locator('[data-ref="legal-doc"]').getByText(`E2E note ${RUN}.`).waitFor();
await shot(pub, 'legal-privacy-mobile');
ok('content: wording fix (same version, new revision) appears on the public /legal page');

await a.getByRole('button', { name: /^Terms, refunds & privacy/ }).click();
await a.locator('[data-ref="new-version"]').click();
await a.locator('[data-ref="publish"]').click();
await reason(a, 'Updated refund terms', 'Publish');
await a.getByText(/patients? will be asked again/).waitFor();
const newVer = sql(`select value ->> 'terms' from app_settings where key = 'consent_versions'`);
cleanup.push(`delete from content_versions where key = 'terms' and version = '${newVer}'`);
// accepting the new version withdrew her earlier consent: put that back, drop the test one
const consentAt = sql(`select now()`);
cleanup.push(`update consents set withdrawn_at = null where user_id = '${SHABNA}' and version <> '${newVer}' and withdrawn_at >= '${consentAt}'`);
cleanup.push(`delete from consents where user_id = '${SHABNA}' and consent_type <> 'whatsapp_opt_in' and version = '${newVer}'`);
const pat = await newPage({ width: 390, height: 844 });
await otpLogin(pat, '9847000003');
await pat.waitForURL(/\/p\/consent/);
for (const k of ['teleconsultation', 'data_processing', 'terms']) {
  await pat.locator(`#consent-${k}`).check();   // asserts the end state (no read-then-toggle race)
}
await pat.locator('[data-ref="legal-links"]').getByText('Refund Policy').waitFor();
await pat.getByRole('button', { name: /agree/i }).click();
await pat.waitForURL((u) => !u.pathname.startsWith('/p/consent'));
if (sql(`select count(*) from consents where user_id = '${SHABNA}' and consent_type = 'terms' and version = '${newVer}' and granted`) !== '1') throw new Error('re-consent not recorded');
ok(`content: new terms version ${newVer} → the patient must accept again before continuing (legal pages linked)`);

// ---------------------------------------------------------------- 8. users & roles
await a.goto(`${BASE}/a/users`);
await a.locator('[data-ref="invite"]').click();
const email = `e2e.coord.${RUN.toLowerCase()}@sunrise.test`;
await a.locator('#i-name').fill(`E2E Coordinator ${RUN}`);
await a.locator('#i-email').fill(email);
await reason(a, 'New support coordinator', 'Send invite');
const link = await a.locator('[data-ref="invite-link"]').inputValue();
if (!/^https?:\/\//.test(link)) throw new Error(`invite link: ${link}`);
await a.keyboard.press('Escape');
const s = await newPage();
await s.goto(link);
await s.waitForURL(/\/set-password/);
await s.locator('#pw1').fill(`Welcome${RUN}2026`);
await s.locator('#pw2').fill(`Welcome${RUN}2026`);
await s.getByRole('button', { name: 'Save password' }).click();
await s.waitForURL(/\/login/);
await staffLogin(s, email, `Welcome${RUN}2026`);
ok('users: invite link (local mode) → set password → the new coordinator signs in with email + password');

await a.goto(`${BASE}/a/users`);
await a.getByLabel('Search name, phone or email').fill(email);
await a.getByRole('button', { name: `Roles for E2E Coordinator ${RUN}` }).click();
await a.getByRole('dialog').last().getByRole('checkbox').nth(1).uncheck();
await reason(a, 'Trial access ended', 'Save');
await a.getByText('Roles saved').waitFor();
if (sql(`select count(*) from user_roles r join profiles p on p.id = r.user_id where p.email = '${email}'`) !== '0') throw new Error('roles not removed');
if (await a.getByRole('button', { name: /Roles for Sunrise Admin/ }).count()) throw new Error('admin offered to edit own roles');
ok('users: roles removed with a reason (access revoked); nobody is offered their own roles');

// ---------------------------------------------------------------- 9. support
await pat.goto(`${BASE}/p/help`);
await pat.locator('[data-ref="new-ticket"]').click();
await pat.locator('#h-sub').fill(`Refund not received ${RUN}`);
await pat.locator('#h-body').fill('My consultation was cancelled but I have not received the refund yet.');
await pat.locator('[data-ref="ticket-submit"]').click();
await pat.waitForURL(/\/p\/help\/[0-9a-f-]{36}$/);
await c.goto(`${BASE}/a/support`);
await c.locator('[data-ref="ticket-table"]').getByText(`Refund not received ${RUN}`).click();
await c.locator('#t-reply').fill('Checked with the bank: the refund was sent today and reaches you in 5–7 working days.');
await c.locator('[data-ref="ticket-send"]').click();
await c.getByText('Reply sent').waitFor();
await c.locator('[data-ref="internal-toggle"]').click();
await c.locator('#t-reply').fill(`INTERNAL ${RUN}: refund id in Razorpay dashboard`);
await c.locator('[data-ref="ticket-send"]').click();
await c.getByText('Note added').waitFor();
await pick(c, '#t-st', 'Resolved');
await c.locator('#t-res').fill('Refund confirmed sent; bank timeline explained.');
await c.locator('[data-ref="ticket-save"]').click();
await c.getByText('Ticket updated').waitFor();
await shot(c, 'admin-support');
await c.keyboard.press('Escape');
await pat.reload();
await pat.locator('[data-ref="conversation"]').getByText('Checked with the bank').waitFor();
await pat.locator('[data-ref="ticket-status"]').getByText('Resolved').waitFor();
if (await pat.getByText(`INTERNAL ${RUN}`).count()) throw new Error('internal note visible to the patient');
await shot(pat, 'help-ticket-mobile');
ok('support: patient raises a ticket → coordinator replies + internal note → resolved; patient sees the reply, never the note');

// ---------------------------------------------------------------- 10. audit
await a.goto(`${BASE}/a/audit`);
await a.locator('#a-q').fill(`E2E verification ${RUN}`);
await a.locator('[data-ref="audit-table"] tbody tr').filter({ hasText: 'doctors.update' }).first().click();
await a.locator('[data-ref="audit-detail"]').getByText('verification_status').waitFor();
await shot(a, 'admin-audit');
await a.keyboard.press('Escape');
ok('audit log: search by reason finds the verification with a before/after diff');

// ---------------------------------------------------------------- 11. reports
await a.goto(`${BASE}/a/reports`);
for (const k of ['appointments', 'revenue', 'no_shows', 'utilisation', 'follow_ups', 'notifications']) {
  await a.locator(`[data-ref="report-${k}"]`).click();
  await a.locator('[data-ref="report-table"]').or(a.getByText('No data for this period.')).waitFor();
}
await a.locator('[data-ref="report-no_shows"]').click();
await a.locator('[data-ref="report-table"]').getByText('Dr. Arun Nair').waitFor();
const [dl] = await Promise.all([a.waitForEvent('download'), a.locator('[data-ref="report-csv"]').click()]);
await dl.saveAs(`${TMP}/no-shows.csv`);
const csv = readFileSync(`${TMP}/no-shows.csv`, 'utf8');
if (!csv.startsWith('﻿doctor,department,due,completed,patient_no_show')) throw new Error(`csv header: ${csv.slice(0, 80)}`);
await a.locator('[data-ref="report-appointments"]').click();
await a.locator('[data-ref="report-table"]').waitFor();
const [dl2] = await Promise.all([a.waitForEvent('download'), a.locator('[data-ref="report-csv"]').click()]);
await dl2.saveAs(`${TMP}/appointments.csv`);
const csv2 = readFileSync(`${TMP}/appointments.csv`, 'utf8');
if (/Shabna|Anjali Menon|Rajan Pillai|9847000/.test(csv2)) throw new Error('patient identity in the appointments CSV');
await shot(a, 'admin-reports');
ok('reports: all six load; CSV export (BOM, raw values) with no patient names or numbers');

// ---------------------------------------------------------------- 12. phone widths
const m = await newPage({ width: 390, height: 844 });
await staffLogin(m, 'admin@sunrise.demo');
await shot(m, 'admin-dashboard-mobile');
await m.goto(`${BASE}/a/doctors/${DOC}`);
await m.locator('[data-ref="verification"]').waitFor();
await shot(m, 'admin-doctor-mobile');
ok('dashboard and doctor page fit a phone (no horizontal scroll)');

for (const q of cleanup.reverse()) sql(q);
if (errors.length) throw new Error('console errors:\n' + [...new Set(errors)].join('\n'));
await browser.close();
console.log('admin console e2e passed');
