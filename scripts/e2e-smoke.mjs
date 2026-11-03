/**
 * Browser smoke test: login per role (demo OTP / password), guards, shells, Malayalam, dark mode,
 * and full-page screenshots of the style guide. Fails on any console error.
 *   npm run build && npx vite preview --port 4174 &  then  node scripts/e2e-smoke.mjs http://localhost:4174
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:4174';
const OUT = process.argv[3] ?? 'docs/screenshots';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
const errors = [];
const ok = (s) => console.log('✓', s);

async function newPage(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text()) && errors.push(m.text()));
  return page;
}
async function otpLogin(page, tab, phone) {
  await page.goto(`${BASE}/login`);
  await page.getByRole('tab', { name: tab }).click();
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: 'Get OTP' }).click();
  await page.getByLabel('One-time password digit 1').fill('123456');
  await page.getByRole('button', { name: 'Verify & continue' }).click();
}

// Phone
const m = await newPage({ width: 390, height: 844 });
await m.goto(`${BASE}/p`);
await m.getByRole('button', { name: 'Get OTP' }).waitFor();
ok('anonymous /p → login');
await m.screenshot({ path: `${OUT}/login-mobile.png` });
await m.getByLabel('Mobile number').fill('12345');
await m.getByRole('button', { name: 'Get OTP' }).click();
await m.getByText('Enter a valid 10-digit Indian mobile number.').first().waitFor();
ok('inline validation');
await otpLogin(m, 'Patient', '9847000001');
await m.getByRole('heading', { name: 'Home' }).waitFor();
await m.screenshot({ path: `${OUT}/patient-shell-mobile.png` });
ok('patient OTP login → patient shell');
await m.goto(`${BASE}/a`);
await m.getByRole('heading', { name: 'Home' }).waitFor();
ok('patient blocked from /a');
await m.getByRole('navigation', { name: 'Main navigation' }).last().getByRole('link', { name: 'Profile' }).click();
await m.getByRole('radio', { name: 'മലയാളം' }).click();
await m.getByRole('radio', { name: 'ഡാർക്ക്' }).click();
await m.waitForTimeout(300);
await m.screenshot({ path: `${OUT}/patient-profile-ml-dark.png` });
ok('Malayalam + dark mode');
await m.getByRole('radio', { name: 'English' }).click();
await m.getByRole('radio', { name: 'Light' }).click();
await m.getByRole('button', { name: 'Sign out' }).last().click();
await otpLogin(m, 'Doctor', '9847100001');
await m.getByRole('heading', { name: 'Today' }).waitFor();
await m.screenshot({ path: `${OUT}/doctor-shell-mobile.png` });
ok('doctor OTP login → doctor shell');

// Desktop
const d = await newPage({ width: 1440, height: 900 });
await d.goto(`${BASE}/login`);
await d.getByRole('tab', { name: 'Staff' }).click();
await d.getByRole('button', { name: 'Sign in' }).click();
await d.getByRole('heading', { name: 'Dashboard' }).waitFor();
await d.waitForTimeout(500);
if (!(await d.getByRole('button', { name: 'Sign out' }).isVisible())) errors.push('admin sidebar sign-out not visible');
await d.screenshot({ path: `${OUT}/admin-shell-desktop.png` });
ok('admin password login → sidebar shell');
await d.goto(`${BASE}/style-guide`);
await d.getByTestId('panel-dark').waitFor();
await d.waitForTimeout(500);
await d.screenshot({ path: `${OUT}/style-guide-desktop.png`, fullPage: true });
const fails = await d.getByText('Fail', { exact: true }).count();
if (fails) errors.push(`style guide contrast table shows ${fails} failing pair(s)`);
ok('style guide (light + dark side by side)');
await d.getByRole('button', { name: 'Open dialog' }).first().click();
await d.getByRole('dialog').waitFor();
await d.screenshot({ path: `${OUT}/style-guide-dialog.png` });
await d.keyboard.press('Escape');
await d.getByRole('button', { name: 'Success toast' }).first().click();
await d.getByText('Booking confirmed').first().waitFor();
ok('dialog + toast');
const sm = await newPage({ width: 390, height: 844 });
await sm.goto(`${BASE}/style-guide`);
await sm.getByTestId('panel-light').waitFor();
await sm.screenshot({ path: `${OUT}/style-guide-mobile.png`, fullPage: true });
const overflow = await sm.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
if (overflow > 0) errors.push(`style guide overflows horizontally on mobile by ${overflow}px`);
ok('style guide on mobile (no horizontal scroll)');

await browser.close();
if (errors.length) { console.log('\nErrors:\n' + errors.join('\n')); process.exit(1); }
console.log('\nAll checks passed.');
