/**
 * Video consultation end to end: doctor and patient in two browsers with fake camera/microphone,
 * joined to a real LiveKit room (local SFU from stack:up):
 *   waiting room (countdown, device check) · join windows · token never grants recording ·
 *   patient waits → doctor starts (status in_progress) · media flows both ways · quality indicator ·
 *   chat + file share (file joins the consultation documents) · live notes autosave · mute / audio only ·
 *   LiveKit restarted mid-call → both reconnect · webhook call logs · doctor ends → outcome → call log card ·
 *   second consult ended as a technical failure → patient offered the fallback.
 *
 *   npm run stack:up && npm run dev   then   PGHOST=… PGPORT=… PGUSER=postgres node scripts/e2e-video.mjs http://localhost:5173
 */
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = process.argv[3] ?? 'docs/screenshots';
const DB = process.env.STACK_DB ?? 'sunrise_local';
const SCRATCH = process.env.E2E_TMP ?? '.local-stack';
mkdirSync(OUT, { recursive: true });
const sql = (q) => execFileSync('psql', ['-X', '-At', '-q', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const ok = (s) => console.log('✓', s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 20_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await sleep(300);
  }
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
const pages = [];
process.on('uncaughtException', async (e) => {
  console.error('✗', e.message.split('\n')[0]);
  for (const [i, pg] of pages.entries()) await pg.screenshot({ path: `${OUT}/fail-video-${i}.png` }).catch(() => {});
  if (errors.length) console.error('console errors:\n' + [...new Set(errors)].join('\n'));
  process.exit(1);
});
async function newPage(viewport) {
  const ctx = await browser.newContext({ viewport });
  await ctx.grantPermissions(['camera', 'microphone'], { origin: new URL(BASE).origin });
  const page = await ctx.newPage();
  pages.push(page);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|fonts\.g|WebSocket|livekit|could not|signal|ICE|rtc|pc /i.test(m.text()) && errors.push(m.text()));
  return page;
}
async function shot(page, name) {
  const [sw, w] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  if (sw > w) throw new Error(`${name}: horizontal overflow (${sw}px > ${w}px)`);
  await page.screenshot({ path: `${OUT}/${name}.png` });
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
/** True when the remote <video> in the call is actually rendering frames. */
const remoteVideoPlaying = (page) => page.evaluate(() => {
  const v = document.querySelector('[data-ref="remote"] video');
  return !!v && v.readyState >= 2 && v.videoWidth > 0;
});
const logs = (appt, where = 'true') => sql(`select string_agg(coalesce(actor_role, '-') || ':' || event || ':' || source, ',' order by created_at) from call_logs where appointment_id = '${appt}' and ${where}`);

// ---------------------------------------------------------------- data: a doctor with a free gap ↔ Anjali, three video consults
const PT = '00000005-0000-4000-8000-000000000001';
const freeStart = (A, minFrom, len) => sql(`select n from generate_series(${minFrom}, ${minFrom + 600}) n
  where not exists (select 1 from appointments x where x.doctor_id = '${A}' and x.status in ('pending_payment', 'confirmed', 'in_progress', 'completed', 'no_show')
                    and tstzrange(x.start_at, x.end_at) && tstzrange(date_trunc('minute', now()) + make_interval(mins => n), date_trunc('minute', now()) + make_interval(mins => n + ${len})))
  order by n limit 1`);
const consult = (A, startMin, lenMin) => sql(`set app.audit_reason = 'e2e setup';
  with t as (select date_trunc('minute', '2020-01-01 09:00+05:30'::timestamptz + (random() * interval '300 days')) at0),
  s as (insert into slots (doctor_id, start_at, end_at, status) select '${A}', at0, at0 + interval '15 minutes', 'booked' from t returning id),
  d as (select * from doctors where id = '${A}'),
  a as (insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status)
        select 'VID' || substr(md5(random()::text), 1, 5), '${PT}', '00000001-0000-4000-8000-0000000000c8', d.id, d.hospital_id, d.department_id, s.id,
               date_trunc('minute', now()) + make_interval(mins => ${startMin}), date_trunc('minute', now()) + make_interval(mins => ${startMin + lenMin}), 'video', 'first', 800, 'confirmed' from s, d returning id),
  y as (insert into appointment_symptoms (appointment_id, body_area, symptoms, duration, severity, description, vitals, allergies)
        select id, 'chest', '{chest_pain,breathlessness}', '1_3_days', 7, 'Breathless on climbing stairs.', '{"bp":"148/92","spo2":"95"}', 'Penicillin' from a),
  p as (insert into payments (appointment_id, provider, provider_order_id, provider_payment_id, amount, status, captured_at, method)
        select id, 'mock', 'order_vid_' || id, 'pay_mock_upi_80000_vid' || substr(md5(random()::text), 1, 8), 800, 'captured', now(), 'upi' from a)
  select id from a`);
// earlier (failed) runs: take their rooms out of the way
sql(`set app.audit_reason = 'e2e cleanup'; update appointments set status = 'cancelled', outcome = 'cancelled_by_admin' where ref_code like 'VID%' and status in ('confirmed', 'in_progress')`);
// the first seeded doctor with a free 6-minute gap starting in the next 8 minutes
const [A, DOC_NAME, DOC_PHONE, s1] = (() => {
  for (const r of sql(`select d.id || '|' || d.full_name || '|' || right(u.phone, 10) from doctors d join auth.users u on u.id = d.profile_id where u.phone like '9198471%' order by d.id`).split('\n')) {
    const [id, name, phone] = r.split('|');
    const n = Number(freeStart(id, 1, 6));
    if (n <= 8) return [id, name, phone, n];
  }
  throw new Error('no doctor with a free 6-minute gap in the next 8 minutes');
})();
const v1 = consult(A, s1, 3);
const v2 = consult(A, s1 + 3, 3);
const early = consult(A, Number(freeStart(A, 180, 15)), 15);
ok(`setup: ${DOC_NAME} – consults at +${s1} and +${s1 + 3} min (room open now) and one in ~3 h`);

// ---------------------------------------------------------------- 1. patient waiting room
const p = await newPage({ width: 390, height: 844 });
await otpLogin(p, '9847000001');
await p.goto(`${BASE}/p/consult/${early}`);
await p.getByText('The room opens in').waitFor();
if (!(await p.getByRole('button', { name: 'Join now' }).isDisabled())) throw new Error('join must be disabled before the window opens');
await p.getByText(/^You can join from /).waitFor();
ok('waiting room: countdown and disabled Join before the window opens');

await p.goto(`${BASE}/p/appointments`);
await p.locator(`a[href="/p/consult/${v1}"]`).filter({ hasText: 'Join consultation' }).waitFor();
await p.locator(`a[href="/p/consult/${early}"]`).filter({ hasText: 'Waiting room' }).waitFor();
ok('appointments list: "Join consultation" for the open room, "Waiting room" for the later one');

await p.locator(`a[href="/p/consult/${v1}"]`).click();
await p.getByRole('heading', { name: 'Waiting room' }).waitFor();
await p.getByText('The room is open').waitFor();
await until('camera preview', () => p.evaluate(() => { const v = document.querySelector('video[aria-label="Your camera preview"]'); return v && v.videoWidth > 0; }));
await until('mic level moves', async () => Number(await p.getByRole('meter', { name: 'Microphone level' }).getAttribute('aria-valuenow')) > 0);
await p.getByText(/^Good \(\d+ ms\)$/).waitFor();
await p.getByRole('button', { name: 'Play test sound' }).click();
await p.getByText('Not recorded').first().waitFor();
await p.getByText(/emergency|108/i).first().waitFor();
await shot(p, 'video-waiting-room');
ok('device check: live camera preview, microphone level, speaker tone, connection probe; not-recorded + emergency notices');

// token: no recording grant, ever
const tokenResp = p.waitForResponse((r) => r.url().includes('/functions/v1/video-token'));
await p.getByRole('button', { name: 'Join now' }).click();
const creds = await (await tokenResp).json();
const claims = JSON.parse(Buffer.from(creds.token.split('.')[1], 'base64url').toString());
if (creds.provider !== 'livekit' || creds.recording !== false || claims.video.roomRecord !== false || claims.video.room !== creds.room || /[A-Z][a-z]+ [A-Z]/.test(claims.name))
  throw new Error(`token: ${JSON.stringify({ provider: creds.provider, recording: creds.recording, video: claims.video, name: claims.name })}`);
if (creds.room.includes(v1) || /anjali/i.test(creds.room)) throw new Error('room name must not identify the booking or patient');
await p.locator('[data-ref="remote-status"]').filter({ hasText: 'Waiting for the doctor to join…' }).waitFor();
await until('patient joined', () => sql(`select patient_joined_at is not null and status = 'confirmed' from appointments where id = '${v1}'`) === 't');
ok(`patient in the room, waiting for the doctor (token: room-only grant, roomRecord=false, first name only "${claims.name}")`);

// ---------------------------------------------------------------- 2. doctor joins
const d = await newPage({ width: 1366, height: 860 });
await otpLogin(d, DOC_PHONE);
await d.getByRole('heading', { name: DOC_NAME }).waitFor();
await d.locator('a[href^="/d/consult/"]').filter({ hasText: /Start consultation|Rejoin/ }).first().waitFor(); // Today: next consult has a start button
await d.goto(`${BASE}/d/appointments/${v1}`);
await d.locator(`a[href="/d/consult/${v1}"]`).filter({ hasText: 'Start consultation' }).click();
await d.getByRole('heading', { name: 'Before you start' }).waitFor();
await d.getByText('The patient is waiting.').waitFor();
await d.getByText(/Red-flag symptoms/).waitFor();
await d.getByRole('button', { name: 'Start consultation' }).click();
await until('doctor joined → in_progress', () => sql(`select status from appointments where id = '${v1}'`) === 'in_progress');
await until('patient receives doctor video', () => remoteVideoPlaying(p));
await until('doctor receives patient video', () => remoteVideoPlaying(d));
await d.getByRole('tab', { name: 'Symptoms' }).waitFor();
await d.getByText('Breathless on climbing stairs.').waitFor();
await p.getByRole('img', { name: /^Network quality: (Excellent|Good)$/ }).waitFor();
await d.getByRole('img', { name: /^Network quality: (Excellent|Good)$/ }).waitFor();
await shot(d, 'video-call-doctor');
await shot(p, 'video-call-patient');
ok('doctor started: status in_progress, video flowing both ways, side panel with symptoms, quality indicator');

// ---------------------------------------------------------------- 3. chat + file share
await d.getByRole('tab', { name: 'Chat' }).click();
await d.getByPlaceholder('Type a message').fill('Please share your latest ECG.');
await d.keyboard.press('Enter');
await p.getByRole('button', { name: 'Chat' }).locator('span').filter({ hasText: '1' }).waitFor();
await p.getByRole('button', { name: 'Chat' }).click();
await p.getByText('Please share your latest ECG.').waitFor();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
writeFileSync(`${SCRATCH}/ecg-today.png`, png);
await p.locator('[data-ref="chat-file"]').setInputFiles(`${SCRATCH}/ecg-today.png`);
await d.getByRole('button', { name: 'Preview ecg-today.png' }).waitFor();
await d.getByRole('tab', { name: 'Documents' }).click();
await d.getByRole('button', { name: 'Preview ecg-today.png' }).waitFor();
if (sql(`select count(*) from documents where appointment_id = '${v1}' and file_name = 'ecg-today.png'`) !== '1') throw new Error('shared file must join the consultation documents');
await shot(p, 'video-chat-patient');
await p.getByRole('button', { name: 'Close' }).click();
ok('chat: doctor message arrives live (unread badge), patient shares a photo → appears in chat and in Documents');

// ---------------------------------------------------------------- 4. live notes
await d.getByRole('tab', { name: 'Notes' }).click();
await d.locator('[data-ref="note-chief_complaint"]').fill('Exertional breathlessness, 2 days');
await d.locator('[data-ref="note-advice"]').fill('ECG and troponin today.');
await d.locator('[data-ref="notes-state"]').filter({ hasText: /^Saved / }).waitFor();
if (sql(`select status || '|' || chief_complaint from consultations where appointment_id = '${v1}'`) !== 'draft|Exertional breathlessness, 2 days') throw new Error('notes draft');
ok('live notes autosave as the consultation draft');

// ---------------------------------------------------------------- 5. mute, audio only
await p.getByRole('button', { name: 'Mute microphone' }).click();
await d.getByText('Microphone muted').first().waitFor();
await p.getByRole('button', { name: 'Unmute microphone' }).click();
await until('unmuted seen by doctor', async () => !(await d.getByText('Microphone muted').first().isVisible().catch(() => false)));
await p.getByRole('button', { name: 'Switch to audio only' }).click();
await d.locator('[data-ref="remote-status"]').filter({ hasText: 'Camera is off' }).waitFor();
await p.locator('[data-ref="remote-status"]').filter({ hasText: 'Audio only' }).waitFor();
await shot(p, 'video-audio-only');
await p.getByRole('button', { name: 'Switch video back on' }).click();
await until('video back', () => remoteVideoPlaying(d));
await until('logged', () => logs(v1, `event in ('audio_only', 'video_on')`) === 'patient:audio_only:client,patient:video_on:client');
ok('mute seen by the other side; audio only stops video both ways and is logged; video comes back');

// ---------------------------------------------------------------- 6. SFU restart mid-call → reconnect
const cfg = '.local-stack/livekit.yaml';
const pid = readFileSync('.local-stack/livekit.pid', 'utf8').trim();
process.kill(Number(pid), 'SIGKILL');
await p.getByText(/Reconnecting|Connection unstable/).first().waitFor({ timeout: 30_000 });
await shot(p, 'video-reconnecting');
await sleep(1500);
const lk = spawn(process.env.LIVEKIT_BIN ?? '/opt/sb/livekit/livekit-server', ['--config', cfg], { detached: true, stdio: 'ignore' });
lk.unref();
writeFileSync('.local-stack/livekit.pid', String(lk.pid));
// either the SDK resumes on its own, or the app re-joins with a fresh token; the manual button is the last resort
await until('both reconnected', async () => {
  for (const pg of [p, d]) if (await pg.locator('[data-ref="reconnect"]').isVisible().catch(() => false)) await pg.locator('[data-ref="reconnect"]').click();
  return (await remoteVideoPlaying(p)) && (await remoteVideoPlaying(d));
}, 90_000);
await until('reconnect logged', () => /reconnected/.test(logs(v1) ?? ''), 20_000);
ok(`SFU restarted mid-call → both sides back with video (${logs(v1, `event in ('reconnecting', 'reconnected', 'disconnected')`)})`);

// ---------------------------------------------------------------- 7. server-side logs from the LiveKit webhook
await until('webhook logs', () => Number(sql(`select count(*) from call_logs where appointment_id = '${v1}' and source = 'server' and event = 'participant_joined'`)) >= 2, 20_000);
ok('LiveKit webhook (signature-verified) recorded participant_joined for both');

// ---------------------------------------------------------------- 8. doctor ends → outcome → call log
await sleep(4000); // let a little call time accumulate after the reconnect
await d.getByRole('button', { name: 'End consultation' }).click();
await d.locator('[data-ref="end-confirm"]').click();
await d.getByText('How did the consultation go?').waitFor();
await d.locator('[data-ref="outcome-completed"]').click();
await d.waitForURL(`**/d/appointments/${v1}`);
await p.getByRole('heading', { name: 'Consultation complete' }).waitFor({ timeout: 15_000 });
const card = d.locator('[data-ref="call-log"]');
await card.waitFor();
const dur = await card.locator('[data-ref="call-duration"]').innerText();
if (!/^\d+:\d\d$/.test(dur)) throw new Error(`duration: ${dur}`);
await card.getByText('Not recorded').waitFor();
const reconnects = sql(`select count(*) from call_logs where appointment_id = '${v1}' and event = 'reconnecting'`);
await shot(d, 'video-call-log');
await shot(p, 'video-after-patient');
if (sql(`select status from appointments where id = '${v1}'`) !== 'completed') throw new Error('outcome');
ok(`ended by the doctor → completed; patient told live; call log: duration ${dur}, ${reconnects} reconnect log(s), recording off`);

// ---------------------------------------------------------------- 9. technical failure on the second consult
await d.goto(`${BASE}/d/consult/${v2}`);
await d.getByRole('button', { name: 'Start consultation' }).click();
await d.locator('[data-ref="remote-status"]').filter({ hasText: 'Waiting for the patient to join…' }).waitFor();
await d.getByRole('button', { name: 'End consultation' }).click();
await d.locator('[data-ref="end-confirm"]').click();
await d.locator('[data-ref="outcome-technical"]').click();
await d.getByRole('dialog').getByRole('textbox').fill('Patient audio kept dropping');
await d.getByRole('dialog').getByRole('button', { name: 'Technical failure' }).click();
await d.waitForURL(`**/d/appointments/${v2}`);
if (sql(`select status || '/' || outcome from appointments where id = '${v2}'`) !== 'cancelled/technical_failure') throw new Error('technical failure');
await p.goto(`${BASE}/p/consult/${v2}`);
await p.getByText(/stopped because of a technical problem/).waitFor();
await p.goto(`${BASE}/p/appointments`);
await p.getByText(/Choose a free new time|refund/i).first().waitFor();
ok('technical failure → booking cancelled for the doctor reason; patient offered a free reschedule or refund');

if (sql(`select count(*) from call_logs where detail ~* 'anjali|breathless|ECG and troponin'`) !== '0') throw new Error('call logs must not hold names or clinical text');
ok('call logs hold no names or clinical text');

if (errors.length) throw new Error('console errors:\n' + [...new Set(errors)].join('\n'));
await browser.close();
console.log('\nvideo e2e passed');
process.exit(0);
