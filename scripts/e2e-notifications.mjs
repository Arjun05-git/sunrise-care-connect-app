/**
 * Notifications end to end (real stack, mock providers):
 *   a confirmed booking → outbox rows per channel (WhatsApp + SMS + in-app, push only for subscribed devices)
 *   → the dispatcher delivers them with costs · no clinical text, only /l/<token> links · the scheduled job
 *   queues the 1-hour reminder · the patient's bell (live) → opens the secure link · a link for another
 *   account is refused · SMS turned off in preferences → the SMS copy is skipped · a failed SMS (mock number
 *   ending 99) → admin Outbox counters, filters, details, retry → delivered · template edit (unknown
 *   placeholder refused, reason required) · cost rates · feedback 2 h after a completed consultation.
 *
 *   npm run stack:up && npm run dev   then   PGHOST=… PGPORT=… PGUSER=postgres node scripts/e2e-notifications.mjs http://localhost:5173
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
async function until(what, fn, ms = 30000) {
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
  for (const [i, pg] of pages.entries()) await pg.screenshot({ path: `${OUT}/fail-notify-${i}.png`, fullPage: true }).catch(() => {});
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
async function otpLogin(page, phone, from) {
  await page.goto(`${BASE}${from ?? '/login'}`);
  await page.waitForURL((u) => u.pathname.startsWith('/login'));
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
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
}

// ---------------------------------------------------------------- data
const A = '00000004-0000-4000-8000-000000000001';        // Dr Arun
const ANJALI = '00000001-0000-4000-8000-0000000000c8';   // account holder (opted in to WhatsApp)
const PT = '00000005-0000-4000-8000-000000000001';
const RAJAN = '00000001-0000-4000-8000-0000000000c9';
const RAJAN_PT = '00000005-0000-4000-8000-000000000002';
const SYMPTOM = 'Crushing chest pain radiating';            // must never appear in a message
sql(`set app.audit_reason = 'e2e setup';
  insert into notification_prefs (user_id, sms, reminders, push) values ('${ANJALI}', true, true, true)
    on conflict (user_id) do update set sms = true, reminders = true;
  update notifications set read_at = now() where user_id = '${ANJALI}' and read_at is null;
  delete from push_subscriptions where user_id = '${ANJALI}';
  delete from notifications where event_key like 'e2e\_%';`);
if (sql(`select public.whatsapp_opted_in('${ANJALI}')`) !== 't') throw new Error('seed: Anjali should be opted in to WhatsApp');

// a confirmed booking with Dr Arun starting 31–59 minutes from now, made two hours ago (so the 1-hour reminder is due)
const newAppt = (patient, owner, status, startExpr, extra = '') => sql(`set app.audit_reason = 'e2e setup';
  with t as (select date_trunc('minute', '2020-01-01 09:00+05:30'::timestamptz + (random() * interval '300 days')) at0),
  s as (insert into slots (doctor_id, start_at, end_at, status) select '${A}', at0, at0 + interval '15 minutes', 'booked' from t returning id),
  d as (select * from doctors where id = '${A}'),
  a as (insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status, created_at${extra ? ', completed_at' : ''})
        select 'NTE' || substr(md5(random()::text), 1, 5), '${patient}', '${owner}', d.id, d.hospital_id, d.department_id, s.id, f.st, f.st + interval '1 minute', 'video', 'first', 600, '${status}', now() - interval '3 hours'${extra ? `, ${extra}` : ''}
        from s, d, (select ${startExpr} st from generate_series(1, 400) n
                    where not exists (select 1 from appointments x where x.doctor_id = '${A}' and x.status in ('pending_payment', 'confirmed', 'in_progress', 'completed', 'no_show')
                                      and tstzrange(x.start_at, x.end_at + interval '1 minute') && tstzrange(${startExpr}, ${startExpr} + interval '1 minute'))
                    order by n limit 1) f returning id),
  y as (insert into appointment_symptoms (appointment_id, body_area, symptoms, duration, severity, description, allergies)
        select id, 'chest', '{chest_pain}', 'today', 8, '${SYMPTOM} to the left arm.', '' from a)
  select id from a`);
const appt = newAppt(PT, ANJALI, 'confirmed', `now() + make_interval(mins => 31 + (n % 28), secs => 0)`);
const ref = sql(`select ref_code from appointments where id = '${appt}'`);
cleanup.push(`set app.audit_reason = 'e2e cleanup'; update appointments set status = 'cancelled', outcome = 'cancelled_by_admin' where id = '${appt}' and status = 'confirmed'`);
ok(`setup: confirmed video booking ${ref} with Dr Arun for Anjali, ~45 min from now (symptom text on file)`);

// ---------------------------------------------------------------- 1. outbox rows → dispatcher → delivered
const rows = () => sql(`select channel || ':' || status from notifications where event_key = 'booking_confirmed:${appt}' order by channel::text`);
if (!/in_app:delivered/.test(rows()) || !/whatsapp/.test(rows()) || !/sms/.test(rows())) throw new Error(`booking rows: ${rows()}`);
if (/push/.test(rows())) throw new Error('push row without a subscribed device');
await until('WhatsApp + SMS delivered by the dispatcher', () => /sms:delivered/.test(rows()) && /whatsapp:delivered/.test(rows()));
const costs = sql(`select string_agg(channel || '=' || cost_paise, ',' order by channel::text) from notifications where event_key = 'booking_confirmed:${appt}'`);
if (costs !== 'in_app=0,sms=50,whatsapp=13') throw new Error(`costs: ${costs}`);
if (sql(`select count(*) from notifications where user_id = (select profile_id from doctors where id = '${A}') and event_key = 'doctor_new_booking:${appt}'`) === '0') throw new Error('doctor not told');
ok(`booking → WhatsApp + SMS + in-app for the patient, SMS + in-app for the doctor; mock delivery, cost ${costs}`);

const texts = sql(`select string_agg(rendered_text, ' ¦ ') from notifications where appointment_id = '${appt}'`);
if (texts.includes(SYMPTOM.split(' ')[1]) || /chest|pain|allerg/i.test(texts)) throw new Error('clinical text leaked into a message');
const links = texts.match(/https?:\/\/\S+/g) ?? [];
if (!links.length || !links.every((l) => /\/l\/[0-9a-f]{32}$/.test(l))) throw new Error(`unexpected links: ${links.join(' ')}`);
ok(`no clinical details in any message; every link is a /l/<token> (${links.length} links)`);

// ---------------------------------------------------------------- 2. scheduled job: 1-hour reminder
sql(`select public.run_scheduled_jobs()`);
const rem = sql(`select string_agg(channel::text, ',' order by channel::text) from notifications where event_key = 'reminder_1h:${appt}'`);
if (rem !== 'in_app,sms,whatsapp') throw new Error(`reminder rows: ${rem}`);
sql(`select public.run_scheduled_jobs()`);
if (sql(`select count(*) from notifications where event_key = 'reminder_1h:${appt}'`) !== '3') throw new Error('reminder duplicated');
ok('scheduled job queued the 1-hour reminder on every channel, once');

// ---------------------------------------------------------------- 3. patient: bell → secure link
const p = await newPage();
await otpLogin(p, '9847000001');
const bell = p.locator('[data-ref="bell"]');
await bell.waitFor();
await p.waitForFunction(() => document.querySelector('[data-ref="bell"] span')?.textContent?.length);
await bell.click();
const item = p.locator('[data-ref="bell-list"]').getByText(`Ref ${ref}`).first();
await item.waitFor();
await shot(p, 'notify-bell-mobile');
// a live one arrives while the menu is open
sql(`select public.enqueue_notification('${ANJALI}', 'ticket_update', '{"ref":"T-${ref}"}', '/p/profile', 'e2e_ticket:${appt}')`);
await p.locator('[data-ref="bell-list"]').getByText(`T-${ref}`).waitFor();
ok('bell shows the booking message and a new one arrives live (Realtime)');
await item.click();
await p.waitForURL(/\/p\/appointments$/);
await p.keyboard.press('Escape').catch(() => {});

const token = sql(`select token from notification_links where user_id = '${ANJALI}' and path = '/p/consult/${appt}' limit 1`)
  || sql(`select l.token from notification_links l join notifications n on n.link like '%' || l.token where n.event_key = 'reminder_1h:${appt}' limit 1`);
await p.goto(`${BASE}/l/${token}`);
await p.waitForURL((u) => u.pathname === '/p/appointments' || u.pathname === `/p/consult/${appt}`);
if (sql(`select count(*) from notifications where link like '%${token}' and clicked_at is not null`) === '0') throw new Error('click not recorded');
ok('the secure /l link opens the right page after sign-in and records the click');

const docToken = sql(`select l.token from notification_links l where l.path = '/d/appointments/${appt}' limit 1`);
await p.goto(`${BASE}/l/${docToken}`);
await p.getByRole('heading', { name: 'This link can’t be opened' }).waitFor();
await shot(p, 'notify-link-refused-mobile');
ok('a link sent to another account (the doctor) is refused for the patient');

// signed out → sign in → back through the link
const p2 = await newPage();
await otpLogin(p2, '9847000001', `/l/${token}`);
await p2.waitForURL((u) => u.pathname === '/p/appointments' || u.pathname === `/p/consult/${appt}`);
ok('opening a link while signed out → sign in → lands on the linked page');

// ---------------------------------------------------------------- 4. preferences: SMS off → skipped
await p.goto(`${BASE}/p/profile`);
const prefs = p.locator('[data-ref="notify-prefs"]');
await prefs.waitFor();
await prefs.getByRole('switch', { name: 'SMS' }).click();
await p.getByText('Notification settings saved').waitFor();
if (sql(`select sms from notification_prefs where user_id = '${ANJALI}'`) !== 'f') throw new Error('SMS pref not saved');
await shot(p, 'notify-prefs-mobile');
sql(`select public.enqueue_notification('${ANJALI}', 'ticket_update', '{"ref":"TKT-E2E2"}', '/p/profile', 'e2e_ticket2:${appt}')`);
const sms = sql(`select status || ':' || coalesce(error, '') from notifications where event_key = 'e2e_ticket2:${appt}' and channel = 'sms'`);
if (sms !== 'skipped:opted_out') throw new Error(`sms after opt-out: ${sms}`);
await prefs.getByRole('switch', { name: 'SMS' }).click();
await p.getByText('Notification settings saved').nth(0).waitFor();
await until('SMS back on', () => sql(`select sms from notification_prefs where user_id = '${ANJALI}'`) === 't');
ok('SMS switched off in preferences → the next SMS is skipped (opted_out); switched back on');

// ---------------------------------------------------------------- 5. failure → admin Outbox → retry
cleanup.push(`update profiles set phone = '+919847000002' where id = '${RAJAN}'`);
sql(`update profiles set phone = '+919847000099' where id = '${RAJAN}'`);
sql(`select public.enqueue_notification('${RAJAN}', 'ticket_update', '{"ref":"TKT-FAIL"}', '/p/profile', 'e2e_fail:${appt}')`);
const failId = await until('mock SMS to …99 fails', () => sql(`select id from notifications where event_key = 'e2e_fail:${appt}' and channel = 'sms' and status = 'failed'`));
await until('WhatsApp copy fails too', () => sql(`select count(*) from notifications where event_key = 'e2e_fail:${appt}' and channel = 'whatsapp' and status = 'failed'`) === '1');
sql(`update profiles set phone = '+919847000002' where id = '${RAJAN}'`);
ok('WhatsApp + SMS to an invalid number fail permanently (invalid_number)');

const a = await newPage({ width: 1366, height: 900 });
await staffLogin(a, 'admin@sunrise.demo');
await a.goto(`${BASE}/a/notifications`);
await a.locator('[data-ref="outbox-stats"]').waitFor();
await a.waitForFunction(() => Number(document.querySelector('[data-ref="count-sms"]')?.textContent) > 0 && Number(document.querySelector('[data-ref="count-whatsapp"]')?.textContent) > 0);
await a.waitForFunction(() => /₹[1-9]/.test(document.querySelector('[data-ref="cost-period"]')?.textContent ?? ''));
const period = await a.locator('[data-ref="cost-period"]').textContent();
if (!/₹\d/.test(period)) throw new Error(`cost counter: ${period}`);
await a.getByLabel('Status').click();
await a.getByRole('option', { name: 'Failed' }).click();
const failRow = a.locator('[data-ref="outbox-row"]').filter({ hasText: 'SMS' }).filter({ hasText: 'Invalid number' }).first();
await failRow.waitFor();
if (/9847000099/.test(await a.locator('[data-ref="outbox-table"]').textContent())) throw new Error('number not masked');
await shot(a, 'notify-admin-outbox');
await failRow.getByRole('button', { name: 'Message details' }).click();
await a.getByRole('dialog').getByText('Invalid number').first().waitFor();
await a.getByRole('dialog').getByRole('button', { name: 'Send again' }).click();
await a.getByText('Queued to send again').waitFor();
await until('retried SMS delivered', () => sql(`select status from notifications where id = '${failId}'`) === 'delivered');
ok(`admin Outbox: counters per channel, cost ${period.trim()}, failed filter, masked numbers, details → Send again → delivered`);
await a.keyboard.press('Escape');

// ---------------------------------------------------------------- 6. templates + costs
const before = sql(`select body_en from notification_templates where key = 'ticket_update'`);
cleanup.push(`update notification_templates set body_en = $$${before}$$ where key = 'ticket_update'`);
await a.getByRole('tab', { name: 'Templates' }).click();
const card = a.locator('[data-ref="tpl-ticket_update"]');
await card.getByRole('button', { name: 'Edit ticket_update' }).click();
const body = a.getByRole('dialog').getByLabel('WhatsApp / in-app text (English)');
await body.fill('Ticket {{ref}} updated for {{diagnosis}}. View: {{link}}');
await a.getByRole('dialog').getByText('Not allowed: diagnosis').waitFor();
await body.fill('Your Sunrise support ticket {{ref}} has an update. View: {{link}}');
await a.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
await a.getByRole('alertdialog').or(a.getByRole('dialog').last()).getByLabel('Reason for this change').fill('Clearer wording for support updates');
await a.getByRole('button', { name: 'Save' }).last().click();
await a.getByText('Saved').first().waitFor();
await until('template saved', () => sql(`select body_en from notification_templates where key = 'ticket_update'`).startsWith('Your Sunrise support ticket'));
if (sql(`select count(*) from audit_logs where reason = 'Clearer wording for support updates'`) === '0') throw new Error('template edit not audited');
await shot(a, 'notify-admin-templates');
sql(`update notification_templates set body_en = $$${before}$$ where key = 'ticket_update'`);
ok('template edit: an unknown placeholder ({{diagnosis}}) is refused; a valid edit needs a reason and is audited');

await a.keyboard.press('Escape').catch(() => {});
await a.getByRole('tab', { name: 'Costs' }).click();
await a.getByLabel('SMS (per part)').waitFor();
if (await a.getByLabel('SMS (per part)').inputValue() !== '0.25') throw new Error('SMS rate');
await shot(a, 'notify-admin-costs');
ok('cost rates shown in rupees (WhatsApp 0.13 · SMS 0.25 per part · push 0)');

// ---------------------------------------------------------------- 7. feedback after a completed consultation
const done = newAppt(PT, ANJALI, 'completed', `now() - make_interval(hours => 3, mins => n)`, `now() - interval '150 minutes'`);
// a completed consultation would make Anjali's next Dr Arun booking a free follow-up in other suites – undo it afterwards
const undoDone = `set app.audit_reason = 'e2e cleanup'; delete from ratings where appointment_id = '${done}'; update appointments set status = 'cancelled', outcome = 'cancelled_by_admin' where id = '${done}'`;
cleanup.push(undoDone);
sql(`select public.queue_scheduled_notifications()`);
if (sql(`select count(*) from notifications where event_key = 'feedback_request:${done}'`) === '0') throw new Error('feedback request not queued');
const fbPath = sql(`select l.token from notification_links l where l.path = '/p/feedback/${done}' limit 1`);
await p.goto(`${BASE}/l/${fbPath}`);
await p.waitForURL(new RegExp(`/p/feedback/${done}$`));
await p.getByRole('radio', { name: '4 stars' }).click();
await p.getByLabel('Anything else? (optional)').fill('Clear explanation, thank you.');
await p.locator('[data-ref="feedback-send"]').click();
await p.getByText('Thank you for your feedback!').waitFor();
if (sql(`select stars from ratings where appointment_id = '${done}'`) !== '4') throw new Error('rating not stored');
await shot(p, 'notify-feedback-mobile');
ok('feedback request queued 2 h after completion → link → 4 stars saved');

// ---------------------------------------------------------------- 8. no PHI in the outbox overall
const leak = sql(`select count(*) from notifications where created_at > now() - interval '1 hour' and (rendered_text ~* '(chest|pain|diagnos|prescri[bp]tion for|mg\\b)')`);
if (leak !== '0') throw new Error(`${leak} recent messages contain clinical words`);
ok('no recent outbox message contains clinical wording');

sql(`set app.audit_reason = 'e2e cleanup'; update appointments set status = 'cancelled', outcome = 'cancelled_by_admin' where id = '${appt}'`);
sql(undoDone);
if (errors.length) throw new Error('console errors:\n' + [...new Set(errors)].join('\n'));
await browser.close();
console.log('notifications e2e passed');
