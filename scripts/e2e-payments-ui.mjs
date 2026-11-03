/**
 * Payments in the browser against the live stack: patient pays a held booking through the checkout
 * (test gateway) → confirmed → receipt PDF; admin edits a fee, the follow-up policy and refund tiers,
 * grants / revokes an override, issues a partial refund and exports the reconciliation CSV;
 * finance sees policies read-only. Phone + desktop, no horizontal overflow, no console errors.
 *
 *   npm run stack:up && npm run dev   then   PGHOST=… PGPORT=… PGUSER=postgres node scripts/e2e-payments-ui.mjs http://localhost:5173
 */
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = process.argv[3] ?? 'docs/screenshots';
mkdirSync(OUT, { recursive: true });
// start from the seeded policy (a previous failed run may have left changes); needs PG* env vars
execFileSync('psql', ['-X', '-q', '-d', process.env.STACK_DB ?? 'sunrise_local', '-c', `set app.audit_reason = 'e2e reset';
  update follow_up_policy set free_window_days = 14, free_follow_up_count = 1, match_rule = 'same_doctor';
  update app_settings set value = '[{"percent": 100, "min_hours_before": 2}, {"percent": 0, "min_hours_before": 0}]' where key = 'cancellation_tiers';
  update follow_up_overrides set revoked_at = now() where revoked_at is null;`]);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const errors = [];
const pages = [];
const ok = (s) => console.log('✓', s);
process.on('uncaughtException', async (e) => {
  console.error('✗', e.message.split('\n')[0]);
  for (const [i, pg] of pages.entries()) await pg.screenshot({ path: `${OUT}/fail-${i}.png`, fullPage: true }).catch(() => {});
  if (errors.length) console.error('console errors:\n' + [...new Set(errors)].join('\n'));
  process.exit(1);
});
async function newPage(viewport = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  pages.push(page);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text()) && errors.push(m.text()));
  return page;
}
async function shot(page, name) {
  const [sw, w] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  if (sw > w) throw new Error(`${name}: horizontal overflow (${sw}px > ${w}px)`);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}
async function otpLogin(page, phone) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: 'Get OTP' }).click();
  await page.getByLabel('One-time password digit 1').fill('123456');
  await page.getByRole('button', { name: 'Verify & continue' }).click();
}
async function staffLogin(page, email) {
  await page.goto(`${BASE}/login`);
  await page.getByRole('tab', { name: 'Staff' }).click();
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill('Sunrise@123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
}
const reason = async (page, text) => { await page.getByRole('dialog').getByLabel('Reason for this change').fill(text); };

// ---------------------------------------------------------------- 1. patient pays
const p = await newPage();
await otpLogin(p, '9847000003');
await p.getByRole('heading', { name: /Hello/ }).waitFor();
await p.goto(`${BASE}/p/doctors/00000004-0000-4000-8000-000000000002`); // Dr Meera – first consult for this patient
await p.getByText('Choose a time').waitFor();
await p.locator('button[aria-pressed]:not([disabled])').filter({ hasText: /\d:\d\d/ }).first().click();
await p.getByText(/Consultation fee/).waitFor();
await p.getByRole('button', { name: 'Continue' }).click();
await p.getByRole('radio', { name: 'Whole body / general' }).click();
await p.getByRole('radio', { name: 'Today' }).click();
await p.getByLabel('Describe it in your own words').fill('Mild fever since this morning, no other complaints.');
await p.getByRole('button', { name: 'Continue to review' }).click();
await p.getByText('Slot held for you').waitFor();
const ref = (await p.url()).split('/').pop();
await p.getByRole('button', { name: /^Pay ₹/ }).click();
const dlg = p.getByRole('dialog', { name: 'Test payment' });
await dlg.waitFor();
await dlg.getByRole('radio', { name: 'Card' }).click();
await shot(p, 'payment-checkout');
await dlg.getByRole('button', { name: 'Simulate a declined payment' }).click();
await p.getByText("The payment didn't go through. You can try again while your slot is held.").waitFor();
await p.getByRole('button', { name: /^Pay ₹/ }).click();
await dlg.getByRole('radio', { name: 'UPI' }).click();
await dlg.getByRole('button', { name: /^Pay ₹/ }).click();
await p.getByRole('heading', { name: 'Booking confirmed' }).waitFor();
const bookingRef = await p.locator('.font-mono').first().textContent();
const [download] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: /Download receipt SCR-/ }).click()]);
const file = await download.path();
if (readFileSync(file).subarray(0, 5).toString() !== '%PDF-' || !/^SCR-\d{4}-\d{6}\.pdf$/.test(download.suggestedFilename())) throw new Error('receipt download');
await shot(p, 'payment-confirmed');
ok(`patient: declined attempt, then UPI payment → booking ${bookingRef} confirmed (${ref.slice(0, 8)}…), receipt ${download.suggestedFilename()} downloaded`);

// ---------------------------------------------------------------- 2. admin: fees
const a = await newPage({ width: 1280, height: 900 });
await staffLogin(a, 'admin@sunrise.demo');
await a.goto(`${BASE}/a/fees`);
await a.getByRole('heading', { name: 'Department defaults' }).waitFor();
const meeraVideoFirst = a.getByRole('button', { name: 'Edit fee: Dr. Meera Krishnan – Video · First' });
await meeraVideoFirst.click();
await a.getByRole('dialog').getByLabel('Amount').fill('650');
const save = a.getByRole('dialog').getByRole('button', { name: 'Save' });
if (!(await save.isDisabled())) throw new Error('save must need a reason');
await reason(a, 'Senior consultant revision');
await save.click();
await a.getByText('Fee saved').waitFor();
const meeraRow = a.getByRole('row', { name: /Dr\. Meera Krishnan/ });
await meeraRow.getByText('₹650').waitFor();
await meeraRow.getByText('Own').first().waitFor();
await shot(a, 'admin-fees');
await meeraVideoFirst.click();
await a.getByRole('dialog').getByRole('switch').click();
await reason(a, 'Back to department rate');
await a.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
await a.getByText('Doctor now uses the department fee').waitFor();
ok('fees: doctor fee set with reason (shown as "Own"), then reverted to the department fee');

// ---------------------------------------------------------------- 3. admin: policies + override
await a.goto(`${BASE}/a/policies`);
await a.getByRole('heading', { name: 'Free follow-up policy' }).waitFor();
await a.getByLabel('Free window (days)').fill('21');
await a.getByText(/1 free follow-up \(same doctor\) within 21 days/).waitFor();
await a.getByRole('button', { name: 'Save policy' }).click();
await reason(a, 'Board decision: 21-day window');
await a.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
await a.getByText('Saved').first().waitFor();
await a.getByLabel('Refund %').first().fill('90');
await a.getByText('90% refund if you cancel at least 2 hours before the start.').waitFor();
await a.getByLabel('Cancelled at least (hours before)').last().fill('2');
await a.getByText(/Each tier needs hours/).waitFor(); // duplicate hours and no 0-hour tier → invalid
await a.getByLabel('Cancelled at least (hours before)').last().fill('0');
await a.getByRole('button', { name: 'Save refund tiers' }).click();
await reason(a, 'Refund policy update test');
await a.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
await a.getByText('Saved').first().waitFor();
await a.getByRole('button', { name: 'Grant free follow-up' }).click();
await a.getByRole('dialog').getByLabel('Patient').fill('Anjali');
await a.getByRole('option', { name: /Anjali Menon/ }).click();
await reason(a, 'Lab report delayed by our lab');
await a.getByRole('dialog').getByRole('button', { name: 'Grant free follow-up' }).click();
await a.getByText('Override granted').waitFor();
await a.getByRole('listitem').filter({ hasText: 'Lab report delayed by our lab' }).waitFor();
await shot(a, 'admin-policies');
await a.getByRole('button', { name: 'Revoke override for Anjali Menon' }).click();
await reason(a, 'Granted for the test only');
await a.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
await a.getByText('Override revoked').waitFor();
// restore defaults so the demo data stays as seeded
await a.getByLabel('Free window (days)').fill('14');
await a.getByRole('button', { name: 'Save policy' }).click();
await reason(a, 'Restore 14-day window');
await a.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
await a.getByText('Saved').first().waitFor();
await a.getByLabel('Refund %').first().fill('100');
await a.getByRole('button', { name: 'Save refund tiers' }).click();
await reason(a, 'Restore refund policy');
await a.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
ok('policies: follow-up window + refund tiers saved with reasons (validation shown), override granted and revoked');

// ---------------------------------------------------------------- 4. admin: payments, partial refund, export
await a.goto(`${BASE}/a/payments`);
await a.getByRole('heading', { name: 'Payments' }).waitFor();
await a.getByRole('button', { name: bookingRef }).click();
const sheet = a.getByRole('dialog');
await sheet.getByRole('button', { name: 'Refund' }).click();
await a.getByRole('radio', { name: 'Partial' }).click();
await a.getByLabel('Amount').fill('100');
await a.getByText(/For reference: if the patient cancelled now/).waitFor();
await reason(a, 'Partial refund: connection issues');
await a.getByRole('button', { name: 'Refund ₹100' }).click();
await a.getByText('Refund issued').waitFor();
await a.getByRole('dialog').getByText('Partly refunded').waitFor();
await a.getByRole('dialog').getByText('Refunded', { exact: true }).first().waitFor();
await shot(a, 'admin-payment-detail');
await a.keyboard.press('Escape');
const [csv] = await Promise.all([a.waitForEvent('download'), a.getByRole('button', { name: 'Reconciliation CSV' }).click()]);
const text = readFileSync(await csv.path(), 'utf8');
if (!text.startsWith('\uFEFFtype,date_time_ist,booking_ref') || !text.includes(bookingRef) || !text.includes(',-100,') || /Anjali|fever/i.test(text)) throw new Error('csv content');
await shot(a, 'admin-payments');
ok(`payments: partial ₹100 refund → partly refunded; CSV export (${text.trim().split('\n').length - 1} rows, no patient names)`);

// ---------------------------------------------------------------- 5. finance (phone): read-only policies, payments list
const f = await newPage();
await staffLogin(f, 'finance@sunrise.demo');
await f.goto(`${BASE}/a/policies`);
await f.getByText('View only – policies can be changed by admins.').waitFor();
if (await f.getByRole('button', { name: 'Save policy' }).count()) throw new Error('finance must not edit policies');
await f.goto(`${BASE}/a/payments`);
await f.getByRole('listitem').getByText(bookingRef).waitFor();
await shot(f, 'admin-payments-mobile');
await f.goto(`${BASE}/a/fees`);
await f.getByRole('heading', { name: 'Doctor fees' }).waitFor();
await shot(f, 'admin-fees-mobile');
ok('finance: policies read-only, payments + fees usable on a phone');

await browser.close();
if (errors.length) {
  console.error('✗ console errors:\n' + [...new Set(errors)].join('\n'));
  process.exit(1);
}
console.log('\nall payment UI checks passed');
