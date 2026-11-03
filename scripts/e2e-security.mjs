/**
 * Security regressions end to end against the live local stack (docs/SECURITY.md):
 *   staff TOTP MFA – first sign-in enrols (QR + key), wrong code refused, console only after the code,
 *   next sign-in asks for a code · the REST API refuses direct writes found in the review (his_mrn, profile
 *   phone, consent rewrite, FINAL note by a doctor) and anon calls to write_audit · documents-register
 *   rejects HTML renamed to .pdf and PDFs with JavaScript (file deleted), refuses another family's path
 *   (their file untouched), registers a clean PDF with the server's type and size · the Send SMS hook refuses
 *   unsigned calls and non-Indian numbers and rate-limits each number.
 *
 *   npm run stack:up && npm run dev   then   PGHOST=… PGPORT=… PGUSER=postgres node scripts/e2e-security.mjs http://localhost:5173
 */
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = process.argv[3] ?? 'docs/screenshots';
const API = process.env.SUPABASE_LOCAL_URL ?? 'http://127.0.0.1:54321';
const DB = process.env.STACK_DB ?? 'sunrise_local';
const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split('\n').map((l) => l.split('=')).filter((p) => p.length >= 2).map(([k, ...v]) => [k, v.join('=')]));
const ANON = env.VITE_SUPABASE_ANON_KEY;
const HOOK_SECRET = readFileSync('.local-stack/sms-hook.secret', 'utf8').trim();
mkdirSync(OUT, { recursive: true });
const sql = (q) => execFileSync('psql', ['-X', '-At', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const ok = (s) => console.log('✓', s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- TOTP (RFC 6238, SHA-1, 30 s, 6 digits)
const base32 = (s) => {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += abc.indexOf(c).toString(2).padStart(5, '0');
  return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
};
const totp = (secret, step = Math.floor(Date.now() / 30000)) => {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
};

// ---------------------------------------------------------------- API helpers
const rest = (path, { token, method = 'GET', body, headers = {} } = {}) => fetch(`${API}${path}`, {
  method, headers: { apikey: ANON, Authorization: `Bearer ${token ?? ANON}`, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
});
async function otpToken(phone) {
  await rest('/auth/v1/otp', { method: 'POST', body: { phone } });
  const r = await (await rest('/auth/v1/verify', { method: 'POST', body: { phone, token: '123456', type: 'sms' } })).json();
  if (!r.access_token) throw new Error(`no session for ${phone}`);
  return r.access_token;
}
const denied = async (what, res) => {
  const body = await res.text();
  if (res.ok || !/42501|permission denied|not allowed/i.test(body)) throw new Error(`${what}: expected permission denied, got ${res.status} ${body.slice(0, 120)}`);
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const errors = [];
const cleanup = [];
const pages = [];
process.on('uncaughtException', async (e) => {
  console.error('✗', e.message.split('\n')[0]);
  for (const [i, pg] of pages.entries()) await pg.screenshot({ path: `${OUT}/fail-security-${i}.png`, fullPage: true }).catch(() => {});
  if (errors.length) console.error('console errors:\n' + [...new Set(errors)].join('\n'));
  for (const q of cleanup) try { sql(q); } catch { /* best effort */ }
  process.exit(1);
});

const FINANCE = '00000001-0000-4000-8000-000000000002';
const PT = '00000005-0000-4000-8000-000000000001';
const RAJAN_PT = '00000005-0000-4000-8000-000000000002';

// ---------------------------------------------------------------- 1. staff MFA
sql(`delete from auth.mfa_factors where user_id = '${FINANCE}'`);
sql(`update app_settings set value = 'true' where key = 'staff_mfa_required'`);
cleanup.push(`update app_settings set value = 'false' where key = 'staff_mfa_required'`, `delete from auth.mfa_factors where user_id = '${FINANCE}'`);
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
pages.push(page);
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|fonts\.g|WebSocket|status of 4\d\d/.test(m.text()) && errors.push(m.text()));
const staffLogin = async () => {
  await page.goto(`${BASE}/login`);
  await page.getByRole('tab', { name: 'Staff' }).click();
  await page.getByLabel('Work email').fill('finance@sunrise.demo');
  await page.getByLabel('Password').fill('Sunrise@123');
  await page.getByRole('button', { name: 'Sign in' }).click();
};
await staffLogin();
await page.waitForURL(/\/mfa$/);
await page.getByRole('heading', { name: 'Set up two-step sign-in' }).or(page.getByText('Set up two-step sign-in')).first().waitFor();
await page.locator('[data-ref="mfa-qr"]').waitFor();
await page.goto(`${BASE}/a/payments`);
await page.waitForURL(/\/mfa$/);
// each visit to an unconfirmed enrolment starts a new one, so read the key shown now
await page.locator('[data-ref="mfa-qr"]').waitFor();
const secret = (await page.locator('[data-ref="mfa-secret"]').textContent()).trim();
await page.screenshot({ path: `${OUT}/security-mfa-enrol-mobile.png`, fullPage: true });
ok('staff password sign-in with MFA required → /mfa enrolment (QR + key); console URLs bounce back to /mfa');

await page.getByLabel('6-digit code').fill('000000');
await page.getByRole('button', { name: 'Confirm' }).click();
await page.getByText('That code didn’t work', { exact: false }).or(page.getByText("That code didn't work", { exact: false })).first().waitFor();
const step1 = Math.floor(Date.now() / 30000);
await page.getByLabel('6-digit code').fill(totp(secret, step1));
await page.getByRole('button', { name: 'Confirm' }).click();
await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
if (sql(`select count(*) from auth.mfa_factors where user_id = '${FINANCE}' and status = 'verified'`) !== '1') throw new Error('factor not verified');
ok('wrong code refused; the authenticator code verifies the factor and opens the console (aal2)');

await page.getByRole('button', { name: 'Sign out' }).first().click().catch(async () => { await page.goto(`${BASE}/a/settings`); await page.getByRole('button', { name: 'Sign out' }).click(); });
await page.waitForURL(/\/login/);
await staffLogin();
await page.waitForURL(/\/mfa$/);
await page.getByText('Enter your sign-in code').first().waitFor();
if (await page.locator('[data-ref="mfa-qr"]').count()) throw new Error('QR shown again for an enrolled user');
while (Math.floor(Date.now() / 30000) === step1) await sleep(1000);   // a fresh code, never the one just used
await page.getByLabel('6-digit code').fill(totp(secret));
await page.getByRole('button', { name: 'Confirm' }).click();
await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
ok('next sign-in: password, then a fresh TOTP code (no QR) → console');

// ---------------------------------------------------------------- 2. REST: closed direct writes
const anjali = await otpToken('+919847000001');
await denied('patient sets his_mrn', await rest(`/rest/v1/patients?id=eq.${PT}`, { token: anjali, method: 'PATCH', body: { his_mrn: 'SUN999999' } }));
await denied('patient marks ABHA verified', await rest(`/rest/v1/patients?id=eq.${PT}`, { token: anjali, method: 'PATCH', body: { abha_number: '11-1111-1111-1111', abha_verified_at: new Date().toISOString() } }));
await denied('patient changes profile phone', await rest('/rest/v1/profiles?id=eq.00000001-0000-4000-8000-0000000000c8', { token: anjali, method: 'PATCH', body: { phone: '+919999999999' } }));
await denied('patient rewrites consent', await rest('/rest/v1/consents?user_id=eq.00000001-0000-4000-8000-0000000000c8', { token: anjali, method: 'PATCH', body: { version: '9.9' } }));
await denied('patient inserts a document row', await rest('/rest/v1/documents', { token: anjali, method: 'POST', body: { patient_id: PT, uploaded_by: '00000001-0000-4000-8000-0000000000c8', tag: 'other', file_name: 'x.pdf', mime_type: 'application/pdf', size_bytes: 1, storage_path: `patients/${PT}/x.pdf` } }));
const doctor = await otpToken('+919847100001');
const appt = sql(`select a.id || '|' || p.id from appointments a join doctors d on d.id = a.doctor_id, patients p
  where d.id = '00000004-0000-4000-8000-000000000001' and not exists (select 1 from consultations c where c.appointment_id = a.id)
    and not exists (select 1 from appointments x where x.patient_id = p.id and x.doctor_id = d.id) limit 1`).split('|');
await denied('doctor writes a FINAL note for an unrelated patient', await rest('/rest/v1/consultations', { token: doctor, method: 'POST', body: { appointment_id: appt[0], doctor_id: '00000004-0000-4000-8000-000000000001', patient_id: appt[1], status: 'final' } }));
await denied('anon forges an audit entry', await rest('/rest/v1/rpc/write_audit', { method: 'POST', body: { p_action: 'forged', p_entity: 'x', p_entity_id: 'x', p_before: null, p_after: null, p_reason: 'x' } }));
await denied('patient forges an audit entry', await rest('/rest/v1/rpc/write_audit', { token: anjali, method: 'POST', body: { p_action: 'forged', p_entity: 'x', p_entity_id: 'x', p_before: null, p_after: null, p_reason: 'x' } }));
if (!(await rest('/rest/v1/rpc/public_content', { method: 'POST', body: { p_key: 'terms_of_use' } })).ok) throw new Error('public legal text broke');
ok('REST: his_mrn / ABHA / profile phone / consent / document rows / FINAL note / audit forging all refused; public legal text still served');

// ---------------------------------------------------------------- 3. documents-register
const upload = async (patient, id, ext, mime, bytes) => {
  const r = await fetch(`${API}/storage/v1/object/medical-documents/patients/${patient}/${id}.${ext}`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${anjali}`, 'Content-Type': mime }, body: bytes });
  if (!r.ok) throw new Error(`upload ${r.status} ${await r.text()}`);
};
const register = (patient, id, ext, token = anjali) => rest('/functions/v1/documents-register', { token, method: 'POST', body: { document_id: id, patient_id: patient, ext, tag: 'lab_report', file_name: `report.${ext}` } });
const objects = (id) => sql(`select count(*) from storage.objects where name like '%${id}%'`);

const fake = randomUUID();
await upload(PT, fake, 'pdf', 'application/pdf', Buffer.from('<html><script>alert(document.cookie)</script></html>'));
let r = await register(PT, fake, 'pdf');
if (r.status !== 400 || (await r.json()).error !== 'type' || objects(fake) !== '0') throw new Error('HTML renamed to .pdf was not rejected and deleted');
const js = randomUUID();
await upload(PT, js, 'pdf', 'application/pdf', Buffer.from('%PDF-1.7\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n%%EOF'));
r = await register(PT, js, 'pdf');
if (r.status !== 400 || (await r.json()).error !== 'active_content' || objects(js) !== '0') throw new Error('PDF with JavaScript was not rejected and deleted');
ok('documents-register: HTML renamed .pdf → type, PDF with JavaScript → active_content; both files deleted');

const rajan = await otpToken('+919847000002');
const theirs = randomUUID();
const rr = await fetch(`${API}/storage/v1/object/medical-documents/patients/${RAJAN_PT}/${theirs}.pdf`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${rajan}`, 'Content-Type': 'application/pdf' }, body: Buffer.from('%PDF-1.4\n<html>not really</html>') });
if (!rr.ok) throw new Error(`rajan upload ${rr.status}`);
r = await register(RAJAN_PT, theirs, 'pdf', anjali);
if (r.status !== 404 || objects(theirs) !== '1') throw new Error(`another family's file: ${r.status}, objects ${objects(theirs)}`);
cleanup.push(`delete from storage.objects where name like '%${theirs}%'`);
sql(`delete from storage.objects where name like '%${theirs}%'`);
ok("registering another family's path → not_found, and their file is left untouched");

const good = randomUUID();
const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
await upload(PT, good, 'pdf', 'application/pdf', pdf);
r = await register(PT, good, 'pdf');
const doc = await r.json();
if (!r.ok || doc.mime_type !== 'application/pdf' || doc.size_bytes !== pdf.length || doc.uploaded_by !== '00000001-0000-4000-8000-0000000000c8') throw new Error(`clean pdf: ${r.status} ${JSON.stringify(doc)}`);
cleanup.push(`delete from documents where id = '${good}'`, `delete from storage.objects where name like '%${good}%'`);
for (const q of cleanup.splice(-2)) sql(q);
ok(`a clean PDF registers with the server's type and size (${pdf.length} bytes) and the caller as uploader`);

// ---------------------------------------------------------------- 4. Send SMS hook
const hook = (body, signed = true) => {
  const id = `msg_${randomUUID()}`;
  const ts = Math.floor(Date.now() / 1000);
  const key = Buffer.from(HOOK_SECRET.replace(/^v1,whsec_/, ''), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return fetch(`${API}/functions/v1/auth-sms-hook`, { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': signed ? `v1,${sig}` : 'v1,AAAA' }, body });
};
const sms = (phone) => JSON.stringify({ user: { id: randomUUID(), phone }, sms: { otp: '482913' } });
if ((await hook(sms('919847000001'), false)).status !== 401) throw new Error('unsigned hook call accepted');
if ((await hook(sms('447700900123'))).status !== 400) throw new Error('non-Indian number accepted');
const num = `9198${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
for (let i = 1; i <= 5; i++) if ((await hook(sms(num))).status !== 200) throw new Error(`OTP ${i} for a fresh number refused`);
const sixth = await hook(sms(num));
if (sixth.status !== 429) throw new Error(`6th OTP in 15 min: ${sixth.status}`);
if (sql(`select count(*) from rate_limits where key like '%${num}%'`) !== '0') throw new Error('phone number stored in rate_limits');
ok('Send SMS hook: unsigned → 401, UK number → 400, 5 codes per number then 429; rate-limit keys are hashes, not numbers');

for (const q of cleanup) sql(q);
if (errors.length) throw new Error('console errors:\n' + [...new Set(errors)].join('\n'));
await browser.close();
console.log('\nsecurity e2e: all checks passed');
