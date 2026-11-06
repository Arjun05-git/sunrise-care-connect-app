#!/usr/bin/env node
// Runs the whole unit-test suite under several machine time zones. The product runs on Asia/Kolkata and must give the
// same answers on a laptop in IST, a CI runner in UTC and a phone anywhere. A developer's own zone hides bugs
// (most tests were written in IST), so run this before releases:   npm run test:tz  [zone ...]
import { spawnSync } from 'node:child_process';

const given = process.argv.slice(2);
const zones = given.length ? given : ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Kolkata'];
const failed = [];
for (const tz of zones) {
  console.log(`\n=== TZ=${tz}`);
  const r = spawnSync('npx', ['vitest', 'run', '--reporter=dot'], { env: { ...process.env, TZ: tz }, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) failed.push(tz);
}
if (failed.length) {
  console.error(`\n✗ tests fail under: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`\n✓ all tests pass under ${zones.length} time zones (${zones.join(', ')})`);
