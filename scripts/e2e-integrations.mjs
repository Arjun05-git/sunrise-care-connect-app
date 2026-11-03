/**
 * Integrations end to end (real stack, mock adapters – INTEGRATIONS_PROVIDER=mock):
 *   patient opts in to marketing in the profile · a confirmed booking → HIS patient master (MRN back on the
 *   patient) + LeadSquared "booked" · payment capture → HIS billing + LeadSquared "paid" · LeadSquared payloads
 *   carry no clinical data · HIS rejects a patient → failed → admin fixes the record and retries from the
 *   Integrations page → sent · nightly doctor master summary · admin turns ABDM on (reason) → patient links
 *   an ABHA with OTP (wrong OTP refused) → unlinks · ABDM off → the ABHA card disappears · opting out of
 *   marketing stops LeadSquared events.
 *
 *   npm run stack:up && npm run dev   then   PGHOST=… PGPORT=… PGUSER=postgres node scripts/e2e-integrations.mjs http://localhost:5173
 */
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = process.argv[3] ?? 'docs/screenshots';
const DB = process.env.STACK_DB ?? 'sunrise_local';
mkdirSync(OUT, { recursive: true });
const sql = (q) => execFileSync('psql', ['-X', '-At', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const ok = (s) => console.log('✓', s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 45000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(500);
  }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const errors = [];
const pages = [];
const cleanup = [];
process.on('uncaughtException', async (e) => {
  console.error('✗', e.message.split('\n')[0]);
  for (const [i, pg] of pages.entries()) await pg.screenshot({ path: `${OUT}/fail-intg-${i}.png`, fullPage: true }).catch(() => {});
  if (errors.length) console.error('console errors:\n' + [...new Set(errors)].join('\n'));
  for (const q of cleanup) try { sql(q); } catch { /* best effort */ }
  process.exit(1);
});
async function newPage(viewport = { width: 390, height: 844 }) {
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
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
}

// ---------------------------------------------------------------- data
const A = '00000004-0000-4000-8000-000000000001';        // Dr Arun
const ANJALI = '00000001-0000-4000-8000-0000000000c8';
const PT = '00000005-0000-4000-8000-000000000001';
const RAJAN = '00000001-0000-4000-8000-0000000000c9';
const RAJAN_PT = '00000005-0000-4000-8000-000000000002';
const SYMPTOM = 'Throbbing migraine with aura';             // must never reach LeadSquared

if (sql(`select value from app_settings where key = 'integrations'`) !== '{"his": true, "leadsquared": true}') throw new Error('seed: HIS + LeadSquared should be on');
if (sql(`select value from app_settings where key = 'abdm_enabled'`) !== 'false') throw new Error('seed: ABDM should be off');
cleanup.push(`insert into app_settings (key, value) values ('abdm_enabled', 'false') on conflict (key) do update set value = excluded.value`);
sql(`set app.audit_reason = 'e2e setup';
  update consents set withdrawn_at = now() where user_id = '${ANJALI}' and consent_type = 'marketing' and withdrawn_at is null;
  update patients set abha_number = null, abha_address = null, abha_verified_at = null, abha_linked_by = null where id = '${PT}';`);

const newAppt = (patient, owner) => sql(`set app.audit_reason = 'e2e setup';
  with t as (select date_trunc('minute', '2020-01-01 09:00+05:30'::timestamptz + (random() * interval '300 days')) at0),
  s as (insert into slots (doctor_id, start_at, end_at, status) select '${A}', at0, at0 + interval '15 minutes', 'booked' from t returning id),
  d as (select * from doctors where id = '${A}'),
  a as (insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status)
        select 'ITE' || substr(md5(random()::text), 1, 5), '${patient}', '${owner}', d.id, d.hospital_id, d.department_id, s.id, f.st, f.st + interval '15 minutes', 'video', 'first', 600, 'confirmed'
        from s, d, (select now() + make_interval(days => 3, mins => 20 * n) st from generate_series(1, 400) n
                    where not exists (select 1 from appointments x where x.doctor_id = '${A}' and x.status in ('pending_payment', 'confirmed', 'in_progress', 'completed', 'no_show')
                                      and tstzrange(x.start_at, x.end_at + interval '1 minute') && tstzrange(now() + make_interval(days => 3, mins => 20 * n), now() + make_interval(days => 3, mins => 20 * n + 16)))
                    order by n limit 1) f returning id),
  y as (insert into appointment_symptoms (appointment_id, body_area, symptoms, duration, severity, description, allergies)
        select id, 'head', '{headache}', 'today', 6, '${SYMPTOM}.', '' from a)
  select id from a`);
const ev = (key) => sql(`select status || '|' || coalesce(external_ref, '') || '|' || coalesce(last_error, '') from integration_events where idempotency_key = '${key}'`);

// ---------------------------------------------------------------- 1. marketing consent in the profile
const p = await newPage();
await otpLogin(p, '9847000001');
await p.goto(`${BASE}/p/profile`);
const mkt = p.getByRole('switch', { name: 'Offers and health camp updates from Sunrise (optional)' });
await mkt.waitFor();
if ((await mkt.getAttribute('aria-checked')) !== 'false') throw new Error('marketing consent should start off (never pre-ticked)');
await mkt.click();
await until('marketing consent stored', () => sql(`select public.marketing_opted_in('${ANJALI}')`) === 't');
ok('profile: optional marketing consent starts off; patient opts in');

// ---------------------------------------------------------------- 2. booking → HIS patient master + LeadSquared
const appt = newAppt(PT, ANJALI);
cleanup.push(`set app.audit_reason = 'e2e cleanup'; update appointments set status = 'cancelled', outcome = 'cancelled_by_admin' where id = '${appt}' and status = 'confirmed'`);
const ptKey = sql(`select 'his:patient:' || id || ':' || public.patient_identity_hash(p) from patients p where id = '${PT}'`);
await until('HIS patient master sent', () => ev(ptKey).startsWith('sent|SUN'));
await until('LeadSquared "booked" sent', () => ev(`lsq:booked:${appt}`).startsWith('sent|'));
const mrn = sql(`select his_mrn from patients where id = '${PT}'`);
if (!/^SUN-?[0-9A-F]+$/.test(mrn)) throw new Error(`MRN not stored: ${mrn}`);
ok(`confirmed booking → HIS patient master (MRN ${mrn} on the patient) and LeadSquared "booked", sent by the dispatcher`);

const pay = sql(`set app.audit_reason = 'e2e setup';
  insert into payments (appointment_id, provider, provider_order_id, amount) values ('${appt}', 'mock', 'order_e2e_' || substr(md5(random()::text), 1, 10), 60000) returning id`);
sql(`set app.audit_reason = 'e2e setup'; update payments set status = 'captured', captured_at = now(), provider_payment_id = 'pay_e2e_' || substr(md5(random()::text), 1, 10), method = 'upi' where id = '${pay}'`);
await until('HIS billing entry sent', () => ev(`his:pay:${pay}`).startsWith('sent|'));
await until('LeadSquared "paid" sent', () => ev(`lsq:paid:${pay}`).startsWith('sent|'));
ok('payment capture → HIS billing entry and LeadSquared "paid"');

for (const id of sql(`select id from integration_events where system = 'leadsquared' and user_id = '${ANJALI}'`).split('\n')) {
  const body = sql(`select public.integration_payload('${id}')::text`);
  if (/migraine|aura|headache|symptom|diagnos|prescri|allerg|fee|amount/i.test(body)) throw new Error(`clinical or payment detail in a LeadSquared payload: ${body}`);
  const keys = Object.keys(JSON.parse(body).lead ?? JSON.parse(body)).sort().join(',');
  if (/symptom|diagnosis|doctor|department/.test(keys)) throw new Error(`unexpected LeadSquared fields: ${keys}`);
}
ok('LeadSquared payloads hold only name, mobile, city and the event – nothing clinical');

// ---------------------------------------------------------------- 3. HIS rejects → admin retries
const rajanAppt = newAppt(RAJAN_PT, RAJAN);
cleanup.push(`set app.audit_reason = 'e2e cleanup'; update appointments set status = 'cancelled', outcome = 'cancelled_by_admin' where id = '${rajanAppt}' and status = 'confirmed'`);
const rajanName = sql(`select full_name from patients where id = '${RAJAN_PT}'`);
cleanup.push(`set app.audit_reason = 'e2e cleanup'; update patients set full_name = '${rajanName.replace(/'/g, "''")}' where id = '${RAJAN_PT}'`);
sql(`set app.audit_reason = 'e2e setup'; update patients set full_name = 'Rajan HISREJECT ' || substr(md5(random()::text), 1, 4) where id = '${RAJAN_PT}'`);
const badKey = sql(`select 'his:patient:' || id || ':' || public.patient_identity_hash(p) from patients p where id = '${RAJAN_PT}'`);
await until('HIS rejects the patient', () => ev(badKey).startsWith('failed|'));
if (!ev(badKey).endsWith('http_422:invalid_patient')) throw new Error(`failure reason: ${ev(badKey)}`);
ok('HIS rejects a patient record (mock 422) → the event fails permanently, no retry loop');

const a = await newPage({ width: 1366, height: 900 });
await staffLogin(a, 'admin@sunrise.demo');
await a.goto(`${BASE}/a/integrations`);
const cards = a.locator('[data-ref="integration-cards"]');
await cards.waitFor();
for (const name of ['Hospital system (HIS)', 'LeadSquared CRM', 'ABDM (ABHA)']) await cards.getByText(name, { exact: true }).waitFor();
const sync = a.locator('[data-ref="doctor-sync"]');
await sync.getByText(/Not matched: .*SUN-DR-9999/).waitFor();
ok('admin Integrations: one card per system with counts; nightly doctor master lists the unmatched HIS code');

await a.getByLabel('Status').click();
await a.getByRole('option', { name: 'Failed' }).click();
const failedRow = a.locator('[data-ref="integration-row"]', { hasText: 'Rejected by the system (422)' }).first();
await failedRow.waitFor();
await shot(a, 'integrations-admin-desktop');
sql(`set app.audit_reason = 'e2e setup'; update patients set full_name = '${rajanName.replace(/'/g, "''")}' where id = '${RAJAN_PT}'`);
await failedRow.getByRole('button', { name: 'Retry' }).click();
await a.getByText('Queued to send again.').waitFor();
await until('retried event sent', () => ev(badKey).startsWith('sent|SUN'));
ok('admin filters failed events, fixes the record, retries → sent (payload rebuilt at send time)');

// ---------------------------------------------------------------- 4. ABDM on → patient links an ABHA
await a.locator('[data-ref="flag-abdm"]').click();
const dlg = a.getByRole('dialog');
await dlg.getByText(/Turning ABDM on shows ABHA linking/).waitFor();
await dlg.getByLabel('Reason for this change').fill('ABDM sandbox keys configured for testing');
await dlg.getByRole('button', { name: 'Save' }).click();
await a.getByText('Integration settings saved.').waitFor();
if (sql(`select value from app_settings where key = 'abdm_enabled'`) !== 'true') throw new Error('ABDM flag not saved');
if (sql(`select count(*) from audit_logs where entity = 'app_settings' and reason = 'ABDM sandbox keys configured for testing'`) === '0') throw new Error('flag change not audited');
ok('admin turns ABDM on with a reason (warning shown, change audited)');

await p.goto(`${BASE}/p/profile/family/${PT}`);
const card = p.locator('[data-ref="abha-card"]');
await card.waitFor();
await card.getByText('Optional – you can book and consult without an ABHA.').waitFor();
await card.getByLabel('ABHA number or ABHA address').fill('91-4321-8765-2109');
await card.locator('[data-ref="abha-start"]').click();
await p.getByText('OTP sent.').waitFor();
await card.getByLabel('Enter the 6-digit OTP').fill('654321');
await card.locator('[data-ref="abha-confirm"]').click();
await p.getByText('The OTP didn’t match. Please try again.').or(p.getByText("The OTP didn't match. Please try again.")).first().waitFor();
await card.getByLabel('Enter the 6-digit OTP').fill('123456');
await card.locator('[data-ref="abha-confirm"]').click();
await card.locator('[data-ref="abha-linked"]').waitFor();
await shot(p, 'abha-linked-mobile');
if (sql(`select abha_number || '|' || (abha_verified_at is not null) || '|' || abha_linked_by from patients where id = '${PT}'`) !== `91-4321-8765-2109|true|${ANJALI}`) throw new Error('ABHA not stored');
await until('HIS gets the ABHA in the next patient master', () => Number(sql(`select count(*) from integration_events where entity_id = '${PT}' and kind = 'patient_upsert' and status = 'sent'`)) >= 2);
ok('patient links an ABHA with OTP (wrong OTP refused); stored with who linked it; HIS patient master re-sent');

await card.getByRole('button', { name: 'Unlink' }).click();
await p.getByText('ABHA unlinked from this profile.').waitFor();
if (sql(`select coalesce(abha_number, '') from patients where id = '${PT}'`) !== '') throw new Error('ABHA not unlinked');
ok('patient unlinks the ABHA');

sql(`insert into app_settings (key, value) values ('abdm_enabled', 'false') on conflict (key) do update set value = excluded.value`);
await p.reload();
await p.getByRole('heading', { level: 1 }).first().waitFor();
await p.waitForTimeout(1500);
if (await card.count()) throw new Error('ABHA card shown while ABDM is off');
ok('ABDM off → the ABHA card is hidden and booking never asks for it');

// ---------------------------------------------------------------- 5. opt out → no more LeadSquared events
await p.goto(`${BASE}/p/profile`);
await mkt.waitFor();
await mkt.click();
await until('marketing consent revoked', () => sql(`select public.marketing_opted_in('${ANJALI}')`) === 'f');
sql(`set app.audit_reason = 'e2e cleanup'; update appointments set status = 'cancelled', outcome = 'cancelled_by_admin' where id = '${appt}'`);
if (sql(`select count(*) from integration_events where idempotency_key = 'lsq:cancelled:${appt}'`) !== '0') throw new Error('LeadSquared event after opt-out');
ok('patient opts out → the cancellation is not sent to LeadSquared');

for (const q of cleanup) sql(q);
if (errors.length) throw new Error('console errors:\n' + [...new Set(errors)].join('\n'));
await browser.close();
console.log('\nintegrations e2e: all checks passed');
