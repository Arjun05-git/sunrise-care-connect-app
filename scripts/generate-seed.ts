/**
 * Writes the seed files (the SQL itself is built in scripts/seed-sql.ts):
 *   supabase/seed/reference.sql   master data + defaults; no people or credentials; safe in ANY environment
 *   supabase/seed/demo.sql        the demo hospital with known logins; refuses to run unless app.environment = 'demo'
 * Demo timestamps are relative to the moment you run it (so "today" always has consultations):
 *   npm run db:seed:generate   (then `npm run db:test`, or load both files in that order)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildSeedSql } from './seed-sql';

const { reference, demo, stats } = buildSeedSql(new Date());
mkdirSync('supabase/seed', { recursive: true });
writeFileSync('supabase/seed/reference.sql', reference);
writeFileSync('supabase/seed/demo.sql', demo);
console.log(`${stats.slots} slots, ${stats.patients} patients, ${stats.doctors} doctors`);
console.log(`supabase/seed/reference.sql + demo.sql written (${stats.appointments} appointments, ${stats.drugs} drugs, ${stats.icd10} ICD-10 codes)`);
