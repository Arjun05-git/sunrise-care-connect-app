/**
 * Clinical notes + e-prescription end to end (real stack):
 *   doctor sets signing PIN + draws a signature · notes from a template, ICD-10 search, provisional diagnosis,
 *   own template · drug search with the List O / A / B / Prohibited verdicts (blocked with the reason),
 *   allergy + interaction warnings · the API refuses a blocked drug too · wrong PIN → right PIN → signed,
 *   locked, numbered · PDF (letterhead, items, QR code, signature) · patient views / downloads ·
 *   public QR page (validity, doctor, date only) · addendum v2 → old QR says superseded.
 *
 *   npm run stack:up && npm run dev   then   PGHOST=… PGPORT=… PGUSER=postgres node scripts/e2e-prescription.mjs http://localhost:5173
 */
import { chromium } from 'playwright-core';
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = process.argv[3] ?? 'docs/screenshots';
const API = process.env.SUPABASE_LOCAL_URL ?? 'http://127.0.0.1:54321';
const DB = process.env.STACK_DB ?? 'sunrise_local';
const TMP = '.local-stack';
mkdirSync(OUT, { recursive: true });
const sql = (q) => execFileSync('psql', ['-X', '-At', '-q', '-d', DB, '-c', q], { encoding: 'utf8' }).trim();
const keys = Object.fromEntries(readFileSync('.local-stack/keys.env', 'utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
const ok = (s) => console.log('✓', s);
const pdfText = (file) => execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const errors = [];
const pages = [];
process.on('uncaughtException', async (e) => {
  console.error('✗', e.message.split('\n')[0]);
  for (const [i, pg] of pages.entries()) await pg.screenshot({ path: `${OUT}/fail-rx-${i}.png`, fullPage: true }).catch(() => {});
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
async function download(page, trigger, name) {
  const [dl] = await Promise.all([page.waitForEvent('download'), trigger()]);
  const file = `${TMP}/${name}`;
  await dl.saveAs(file);
  return { file, suggested: dl.suggestedFilename() };
}

// ---------------------------------------------------------------- data: an audio first consultation in progress
const A = '00000004-0000-4000-8000-000000000001';
const ARUN = '00000001-0000-4000-8000-000000000064';
const PT = '00000005-0000-4000-8000-000000000001';
sql(`set app.audit_reason = 'e2e setup';
  update doctor_secrets set pin_hash = crypt('1234', gen_salt('bf')), failed_attempts = 0, locked_until = null where profile_id = '${ARUN}';
  update doctors set signature_updated_at = null where id = '${A}';
  delete from note_templates where name = 'E2E cough template';`);
const appt = sql(`set app.audit_reason = 'e2e setup';
  with t as (select date_trunc('minute', '2020-01-01 09:00+05:30'::timestamptz + (random() * interval '300 days')) at0),
  s as (insert into slots (doctor_id, start_at, end_at, status) select '${A}', at0, at0 + interval '15 minutes', 'booked' from t returning id),
  d as (select * from doctors where id = '${A}'),
  a as (insert into appointments (ref_code, patient_id, booked_by_user_id, doctor_id, hospital_id, department_id, slot_id, start_at, end_at, mode, consult_type, fee_amount, status, doctor_joined_at, patient_joined_at)
        select 'RXE' || substr(md5(random()::text), 1, 5), '${PT}', '00000001-0000-4000-8000-0000000000c8', d.id, d.hospital_id, d.department_id, s.id, f.st, f.st + interval '1 minute', 'audio', 'first', 600, 'in_progress', f.st, f.st
        from s, d, (select now() - make_interval(mins => n) st from generate_series(15, 900) n
                    where not exists (select 1 from appointments x where x.doctor_id = '${A}' and x.status in ('pending_payment', 'confirmed', 'in_progress', 'completed', 'no_show')
                                      and tstzrange(x.start_at, x.end_at) && tstzrange(now() - make_interval(mins => n), now() - make_interval(mins => n) + interval '1 minute'))
                    order by n limit 1) f returning id),
  y as (insert into appointment_symptoms (appointment_id, body_area, symptoms, duration, severity, description, allergies)
        select id, 'throat', '{fever,sore_throat}', '1_3_days', 5, 'Fever and sore throat since two days.', 'Domperidone' from a)
  select id from a`);
ok('setup: audio first consultation with Dr Arun for Anjali (penicillin allergy on record, "Domperidone" in the form)');

// ---------------------------------------------------------------- 1. signature + PIN
const d = await newPage({ width: 1366, height: 900 });
await otpLogin(d, '9847100001');
await d.goto(`${BASE}/d/profile`);
await d.getByRole('link', { name: 'Signature & signing PIN' }).click();
await d.getByRole('heading', { name: 'Signature & signing PIN' }).waitFor();
await d.getByLabel('Current PIN').fill('1234');
await d.getByLabel('New PIN', { exact: true }).fill('1111');
await d.getByLabel('Repeat new PIN').fill('1111');
await d.getByRole('button', { name: 'Save', exact: true }).click();
await d.getByText('Choose a less obvious PIN.').waitFor();
await d.getByLabel('New PIN', { exact: true }).fill('482916');
await d.getByLabel('Repeat new PIN').fill('482916');
await d.getByRole('button', { name: 'Save', exact: true }).click();
await d.getByText('Signing PIN saved').waitFor();
const pad = d.locator('[data-ref="sig-pad"]');
const box = await pad.boundingBox();
await d.mouse.move(box.x + 30, box.y + 90);
await d.mouse.down();
for (let i = 0; i <= 40; i++) await d.mouse.move(box.x + 30 + i * 9, box.y + 75 + Math.sin(i / 3) * 35, { steps: 2 });
await d.mouse.up();
await d.locator('#sig-pin').fill('482916');
await d.locator('[data-ref="sig-save"]').click();
await d.getByText('Signature saved').waitFor();
await d.getByRole('img', { name: 'Your current signature' }).waitFor();
if (sql(`select signature_updated_at is not null from doctors where id = '${A}'`) !== 't') throw new Error('signature not recorded');
await shot(d, 'rx-signature-setup');
ok('signing PIN changed (weak PIN refused) and a drawn signature saved with the PIN');

// ---------------------------------------------------------------- 2. notes: template, ICD-10, provisional diagnosis, own template
await d.goto(`${BASE}/d/appointments/${appt}`);
await d.locator('[data-ref="write-link"]').click();
await d.getByRole('heading', { name: 'Anjali Menon' }).waitFor();
await d.getByRole('note').filter({ hasText: 'Penicillin' }).waitFor();
await d.locator('[data-ref="apply-template"]').click();
await d.getByRole('dialog').getByRole('button', { name: /^Upper respiratory infection/ }).click();
await d.locator('[data-ref="note-chief_complaint"]').filter({ hasText: '' }).waitFor();
if ((await d.locator('[data-ref="note-chief_complaint"]').inputValue()) !== 'Fever, sore throat and runny nose') throw new Error('template not applied');
const dx = d.getByRole('combobox', { name: 'Diagnosis (ICD-10)' });
await dx.fill('tonsil');
await d.getByRole('option', { name: /J03\.9/ }).click();
await dx.fill('Viral fever');
await d.getByRole('option', { name: /Add “Viral fever” as a provisional diagnosis/ }).click();
await d.getByRole('list', { name: 'Selected diagnoses' }).getByText('Viral fever').waitFor();
await d.locator('[data-ref="note-history"]').fill('Fever 101 F for two days, sore throat. No breathlessness.');
await d.locator('[data-ref="notes-state"]').filter({ hasText: /^Saved / }).waitFor();
const savedDx = sql(`select string_agg(coalesce(d ->> 'code', 'free:' || (d ->> 'description')), ',') from consultations c, jsonb_array_elements(c.diagnoses) d where c.appointment_id = '${appt}'`);
if (savedDx !== 'J06.9,J03.9,free:Viral fever') throw new Error(`diagnoses: ${savedDx}`);
await d.getByRole('button', { name: 'Save as template' }).click();
await d.getByLabel('Template name').fill('E2E cough template');
await d.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
await d.getByText('Template saved').waitFor();
await d.locator('[data-ref="apply-template"]').click();
await d.getByRole('dialog').getByText('My templates').waitFor();
await d.getByRole('dialog').getByRole('button', { name: /^E2E cough template/ }).waitFor();
await d.keyboard.press('Escape');
ok(`notes: template applied, ICD-10 search (J03.9 by "tonsil"), provisional diagnosis, autosaved (${savedDx}), own template saved`);

// ---------------------------------------------------------------- 3. prescription builder: rules, warnings
const search = d.locator('[data-ref="drug-search"]');
await search.fill('amoxicillin');
const amox = d.locator('[data-ref="drug-hit"]').filter({ hasText: /^Amoxicillin 500/ }).first();
await amox.getByText("List A isn't allowed in this consultation (audio, first consultation): the first prescription needs a video consultation.", { exact: false }).waitFor();
if (!(await amox.getByRole('button', { name: 'Add Amoxicillin' }).isDisabled())) throw new Error('List A must be blocked in an audio first consult');
await shot(d, 'rx-blocked-list-a');
await search.fill('alprazolam');
const alp = d.locator('[data-ref="drug-hit"]').filter({ hasText: 'Alprazolam' });
await alp.getByText(/Prohibited list: can't be prescribed by teleconsultation/).waitFor();
await alp.getByText(/Narcotic \/ psychotropic substance/).waitFor();
await search.fill('prednisolone');
await d.locator('[data-ref="drug-hit"]').filter({ hasText: 'Prednisolone' }).getByText(/List B isn't allowed in this consultation \(audio, first consultation\): only as an add-on in a follow-up/).first().waitFor();
ok('blocked with the reason: List A (audio first), List B (first consult), Prohibited + narcotic');

// an item is matched by the drug name it starts with: interaction warnings on OTHER items name it too
const rxItem = (name) => d.locator('[data-ref="rx-item"]').filter({ hasText: new RegExp(`^\\s*\\d+\\.\\s*${name}`) });   // "3. Ondansetron 4 mg · Tablet"
const addDrug = async (q, name) => {
  await search.fill(q);
  await d.getByRole('button', { name: `Add ${name}`, exact: true }).click();
  await rxItem(name).waitFor();
};
await addDrug('paracetamol 650', 'Paracetamol 650');
await addDrug('domperidone', 'Domperidone');
await addDrug('ondansetron', 'Ondansetron');
const para = rxItem('Paracetamol 650');
await para.getByLabel('Duration').fill('5 days');
await para.getByLabel('Instructions').fill('After food');
await rxItem('Domperidone').getByText('Recorded allergy: domperidone', { exact: false }).waitFor();
await rxItem('Ondansetron').getByText('Two QT-prolonging medicines (Domperidone).').waitFor();
await d.locator('[data-ref="rx-state"]').filter({ hasText: 'Saved' }).waitFor();
// the doctor decides: drop domperidone (allergy), keep the rest
await d.getByRole('button', { name: 'Remove Domperidone' }).click();
await d.locator('[data-ref="rx-state"]').filter({ hasText: 'Saved' }).waitFor();
await shot(d, 'rx-builder');
ok('allowed drugs added with defaults; allergy (from the form) and QT interaction warnings shown; draft autosaved');

// the API enforces the same rules
const arun = createClient(API, keys.ANON_KEY, { auth: { persistSession: false } });
await arun.auth.signInWithOtp({ phone: '+919847100001' });
await arun.auth.verifyOtp({ phone: '+919847100001', token: '123456', type: 'sms' });
const viaApi = await arun.rpc('save_rx_draft', { p_appt: appt, p_items: [{ drug_id: sql(`select id from drug_master where name = 'Amoxicillin'`) }] });
if (viaApi.error?.message !== 'drug_blocked') throw new Error(`API must refuse blocked drugs: ${JSON.stringify(viaApi.error)}`);
const direct = await arun.from('prescription_items').insert({ prescription_id: sql(`select id from prescriptions where appointment_id = '${appt}'`), drug_id: 'drug-101', drug_name: 'Morphine' });
if (!direct.error) throw new Error('direct item insert must be refused');
ok('API: blocked drug refused by save_rx_draft (drug_blocked); direct table writes refused');

// ---------------------------------------------------------------- 4. sign: wrong PIN, then right PIN
await d.locator('[data-ref="rx-sign"]').click();
const dlg = d.getByRole('dialog');
await dlg.getByText('Signature on file').waitFor();
await dlg.getByText('Signing PIN set').waitFor();
await dlg.getByLabel('Signing PIN').fill('000000');
await dlg.locator('[data-ref="sign-confirm"]').click();
await dlg.getByRole('alert').filter({ hasText: 'Wrong PIN. 4 attempts left' }).waitFor();
await dlg.getByLabel('Signing PIN').fill('482916');
await dlg.locator('[data-ref="sign-confirm"]').click();
await d.locator('[data-ref="rx-final"]').waitFor();
const rx1 = sql(`select id || '|' || rx_no || '|' || verification_code from prescriptions where appointment_id = '${appt}' and version = 1 and status = 'final'`).split('|');
if (!/^SCRX-\d{4}-\d{6}$/.test(rx1[1] ?? '')) throw new Error(`rx number: ${rx1[1]}`);
await d.locator('[data-ref="rx-no"]').filter({ hasText: rx1[1] }).waitFor();
await d.getByText('Final – locked with the signed prescription').waitFor();
if (sql(`select status from consultations where appointment_id = '${appt}'`) !== 'final') throw new Error('notes must lock');
await shot(d, 'rx-signed');
ok(`wrong PIN refused (attempts left shown), right PIN → signed ${rx1[1]}; notes locked`);

// PDF stored server-side at signing; text checks
for (let i = 0; i < 20 && sql(`select pdf_path is not null from prescriptions where id = '${rx1[0]}'`) !== 't'; i++) await new Promise((r) => setTimeout(r, 500));
if (sql(`select pdf_path from prescriptions where id = '${rx1[0]}'`) !== `${rx1[0]}-v1.pdf`) throw new Error('PDF not stored');
const docPdf = await download(d, () => d.locator('[data-ref="rx-download"]').click(), 'rx-doctor.pdf');
const txt = pdfText(docPdf.file);
for (const must of [rx1[1], rx1[2], 'Sunrise Chain of Hospitals', 'Anjali Menon', 'Dr. Arun Nair', 'Reg. No.', 'J06.9', 'J03.9', 'Viral fever (provisional)', 'Paracetamol 650', 'Ondansetron', '5 days', 'After food', 'Digitally signed', 'Scan to verify', 'Telemedicine Practice Guidelines 2020'])
  if (!txt.includes(must)) throw new Error(`PDF lacks "${must}"`);
if (/Domperidone|Amoxicillin/.test(txt)) throw new Error('removed / blocked drugs must not be on the PDF');
if (docPdf.suggested !== `Prescription-${rx1[1]}.pdf`) throw new Error(`file name ${docPdf.suggested}`);
execFileSync('pdftoppm', ['-png', '-r', '80', '-f', '1', '-l', '1', docPdf.file, `${OUT}/rx-pdf`]);
ok(`PDF stored at signing and downloadable: letterhead, doctor + registration, patient, ICD codes, items, signature line, QR + code (${docPdf.suggested})`);

// ---------------------------------------------------------------- 5. patient: records, detail, download
const p = await newPage({ width: 390, height: 844 });
await otpLogin(p, '9847000001');
await p.goto(`${BASE}/p/records`);
const card = p.locator('[data-ref="rx-card"]').filter({ hasText: rx1[1] });
await card.waitFor();
await shot(p, 'rx-patient-records');
await card.click();
await p.getByText('Paracetamol 650').waitFor();
await p.getByText('Warm saline gargles', { exact: false }).waitFor();
const patPdf = await download(p, () => p.locator('[data-ref="rx-download"]').click(), 'rx-patient.pdf');
if (!pdfText(patPdf.file).includes(rx1[1])) throw new Error('patient PDF');
await p.locator('[data-ref="rx-share"]').waitFor();
await shot(p, 'rx-patient-detail');
const notif = sql(`select count(*) from notifications n join notification_links l on n.link like '%/l/' || l.token where n.template_key = 'prescription_ready' and n.channel = 'in_app' and l.path = '/p/records/${rx1[0]}'`);
if (notif !== '1') throw new Error('patient notification');
ok('patient: sees it under Records, opens it, downloads the same PDF; notified without clinical details');

// ---------------------------------------------------------------- 6. public QR page
const pub = await newPage({ width: 390, height: 844 });
await pub.goto(`${BASE}/verify/${rx1[2]}`);
await pub.getByText('Valid prescription').waitFor();
const details = await pub.locator('[data-ref="verify-details"]').innerText();
if (!details.includes('Dr. Arun Nair') || !/Issued on/.test(details)) throw new Error('verify details');
const body = await pub.locator('body').innerText();
if (/Anjali|Paracetamol|J06|Viral fever/i.test(body)) throw new Error('public page must not show patient or clinical data');
await shot(pub, 'rx-verify-valid');
await pub.goto(`${BASE}/verify/ABCDEFGH23`);
await pub.getByText('Not a valid prescription').waitFor();
ok('public QR page (no sign-in): valid + doctor + date only; unknown code → not valid');

// ---------------------------------------------------------------- 7. addendum
await d.reload();
await d.locator('[data-ref="rx-amend"]').click();
await d.getByLabel('Reason (shown on the addendum)').fill('Add ORS for dehydration');
await d.locator('[data-ref="amend-start"]').click();
await d.getByText('Addendum – version 2').waitFor();
await addDrug('ors', 'ORS Sachet');
await d.locator('[data-ref="rx-state"]').filter({ hasText: 'Saved' }).waitFor();
await d.locator('[data-ref="rx-sign"]').click();
await d.getByRole('dialog').getByLabel('Signing PIN').fill('482916');
await d.getByRole('dialog').locator('[data-ref="sign-confirm"]').click();
await d.locator('[data-ref="rx-no"]').filter({ hasText: `${rx1[1]}-A1` }).waitFor();
const rx2 = sql(`select id || '|' || verification_code from prescriptions where appointment_id = '${appt}' and version = 2`).split('|');
await pub.goto(`${BASE}/verify/${rx1[2]}`);
await pub.getByText('Replaced by a newer version').waitFor();
await pub.goto(`${BASE}/verify/${rx2[1]}`);
await pub.getByText('Valid prescription').waitFor();
await p.goto(`${BASE}/p/records/${rx1[0]}`);
await p.locator('[data-ref="newer-version"]').click();
await p.getByText('ORS Sachet').waitFor();
await p.getByText('Reason: Add ORS for dehydration', { exact: false }).waitFor();
const v2 = await download(p, () => p.locator('[data-ref="rx-download"]').click(), 'rx-v2.pdf');
const t2 = pdfText(v2.file);
if (!t2.includes(`${rx1[1]}-A1`) || !t2.includes(`replaces ${rx1[1]}`) || !t2.includes('ORS Sachet')) throw new Error('addendum PDF');
if (sql(`select status || '/' || (select count(*) from prescription_items where prescription_id = p.id) from prescriptions p where id = '${rx1[0]}'`) !== 'final/2') throw new Error('original must stay unchanged');
ok(`addendum ${rx1[1]}-A1 signed: old QR → "replaced by a newer version", new QR valid; patient sent to the latest; original unchanged`);

if (errors.length) throw new Error('console errors:\n' + [...new Set(errors)].join('\n'));
await browser.close();
console.log('\nprescription e2e passed');
process.exit(0);
