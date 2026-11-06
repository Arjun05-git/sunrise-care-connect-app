// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildSeedSql, REFERENCE_TABLES } from './seed-sql';

const NOW = new Date('2026-11-05T05:00:00.000Z');
const seed = buildSeedSql(NOW);
const tablesOf = (sql: string) => [...sql.matchAll(/^insert into ([a-z0-9_.]+)/gm)].map((m) => m[1]!);

describe('reference seed – safe to load into ANY environment', () => {
  it('inserts only into the allowed reference tables, and into all of them', () => {
    const tables = new Set(tablesOf(seed.reference));
    expect([...tables].filter((t) => !REFERENCE_TABLES.includes(t))).toEqual([]);
    expect(REFERENCE_TABLES.filter((t) => !tables.has(t))).toEqual([]);
  });

  it('contains no people, passwords, demo accounts or local URLs', () => {
    for (const marker of ['auth.users', 'crypt(', 'gen_salt', 'sunrise.demo', 'Sunrise@123', '+919847', '123456', 'localhost', 'doctor_secrets']) {
      expect(seed.reference, marker).not.toContain(marker);
    }
  });

  it('does not switch MFA or doctor step-up off, and sets no local public URL', () => {
    for (const key of ['staff_mfa_required', 'require_doctor_step_up', 'public_url', 'custom_medicine_mode']) expect(seed.reference, key).not.toContain(`'${key}'`);
  });

  it('carries only system-wide note templates; personal ones need their doctor', () => {
    const block = seed.reference.slice(seed.reference.indexOf('insert into note_templates'));
    const rows = block.slice(0, block.indexOf(';')).split('\n').filter((l) => l.startsWith('  ('));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((l) => !/^  \('[0-9a-f-]{36}', null,/.test(l))).toEqual([]);
  });

  it('leaves the HIS / LeadSquared integrations off until someone turns them on', () => {
    expect(seed.reference).toContain(`('integrations', '{"his":false,"leadsquared":false}'::jsonb)`);
  });

  it('is deterministic: no timestamps, so it can be committed and reviewed', () => {
    const later = buildSeedSql(new Date('2027-03-01T10:00:00.000Z'));
    expect(later.reference).toBe(seed.reference);
  });

  it('runs in one transaction', () => {
    expect(seed.reference).toMatch(/^begin;$/m);
    expect(seed.reference.trimEnd()).toMatch(/commit;$/);
  });
});

describe('demo seed – refuses to run outside an explicit demo database', () => {
  it('checks app.environment before it touches anything', () => {
    const guard = seed.demo.indexOf('app.environment');
    const firstInsert = seed.demo.search(/^insert into/m);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstInsert);
    expect(seed.demo.slice(0, firstInsert)).toMatch(/raise exception/);
  });

  it('accepts only the exact word demo', () => {
    expect(seed.demo).toMatch(/coalesce\(current_setting\('app\.environment', true\), ''\) <> 'demo'/);
  });

  it('creates the demo logins, and switches the demo-only settings', () => {
    expect(tablesOf(seed.demo)).toEqual(expect.arrayContaining(['auth.users', 'patients', 'doctors', 'appointments', 'payments']));
    expect(seed.demo).toContain('Sunrise@123');
    expect(seed.demo).toContain(`('staff_mfa_required', 'false'::jsonb)`);
    expect(seed.demo).toContain(`('require_doctor_step_up', 'false'::jsonb)`);
    expect(seed.demo).toContain(`('integrations', '{"his":true,"leadsquared":true}'::jsonb)`);
  });

  it('switches consultation recording on in the demo, while the reference seed leaves it off', () => {
    expect(seed.demo).toContain(`('recording_enabled', 'true'::jsonb)`);
    expect(seed.reference).toContain(`('recording_enabled', 'false'::jsonb)`);
  });

  it('adds a typed medicine directly in the demo (production keeps the checked default: the key is absent from reference)', () => {
    expect(seed.demo).toContain(`('custom_medicine_mode', '"direct"'::jsonb)`);
  });

  it('overrides settings idempotently on top of the reference seed', () => {
    expect(seed.demo).toMatch(/insert into app_settings[\s\S]*on conflict \(key\) do update set value = excluded\.value/);
  });

  it('repeats a reference table only for the settings override and personal templates', () => {
    const repeated = tablesOf(seed.demo).filter((t) => REFERENCE_TABLES.includes(t));
    expect([...new Set(repeated)].sort()).toEqual(['app_settings', 'note_templates']);
  });

  it('runs in one transaction', () => {
    expect(seed.demo).toMatch(/^begin;$/m);
    expect(seed.demo.trimEnd()).toMatch(/commit;$/);
  });
});

describe('together they are the old demo seed', () => {
  it('cover every table the old combined seed filled', () => {
    const all = new Set([...tablesOf(seed.reference), ...tablesOf(seed.demo)]);
    for (const t of ['auth.users', 'profiles', 'hospitals', 'departments', 'doctors', 'patients', 'slots', 'appointments', 'payments', 'refunds', 'prescriptions', 'prescription_items',
      'icd10_master', 'drug_master', 'drug_rules', 'fee_config', 'follow_up_policy', 'app_settings', 'content_versions', 'notification_templates', 'note_templates', 'audit_logs']) {
      expect(all.has(t), t).toBe(true);
    }
  });
});
