// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain JS module shared with the CLI scripts
import { findTimezoneHazards } from './lib/timezone-hazards.mjs';

const hazards = (src: string) => (findTimezoneHazards(src, 'x.ts') as { rule: string; line: number }[]).map((h) => h.rule);

describe('findTimezoneHazards – code whose result depends on the machine\'s time zone', () => {
  it('flags the local-zone getters and setters', () => {
    for (const call of ['d.getHours()', 'new Date().getDay()', 'x.getDate()', 'd.getMonth()', 'd.getFullYear()', 'd.setHours(0)', 'd.getTimezoneOffset()'])
      expect(hazards(`const v = ${call};`), call).toContain('local-date-api');
  });

  it('flags toLocaleDateString / toLocaleTimeString / toDateString / toTimeString', () => {
    for (const call of ["d.toLocaleDateString('en-IN')", 'd.toLocaleTimeString()', 'd.toDateString()', 'd.toTimeString()'])
      expect(hazards(`const v = ${call};`), call).toContain('local-date-format');
  });

  it('flags toLocaleString and Intl.DateTimeFormat for dates unless they pin a time zone', () => {
    expect(hazards("d.toLocaleString('en-IN', { day: 'numeric', month: 'short' })")).toContain('local-date-format');
    expect(hazards("new Intl.DateTimeFormat('en-IN', { hour: 'numeric' }).format(d)")).toContain('local-date-format');
    expect(hazards("new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric' }).format(d)")).toEqual([]);
    expect(hazards("d.toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' })")).toEqual([]);
  });

  it('flags a date-only string parsed as a date (it is read as UTC midnight)', () => {
    expect(hazards("const d = new Date('2026-11-06');")).toContain('date-only-parse');
    expect(hazards("const d = new Date('2026-11-06T10:00:00+05:30');")).toEqual([]);
  });

  it('does not flag number formatting, UTC getters, or explicit conversions', () => {
    expect(hazards("(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })")).toEqual([]);
    expect(hazards('d.getUTCHours()')).toEqual([]);
    expect(hazards("new Date(Date.UTC(y, m - 1, d, hh, mm) - 330 * 60_000)")).toEqual([]);
  });

  it('honours an inline allow marker and reports line numbers', () => {
    expect(hazards('d.getHours(); // tz-scan:allow local clock on purpose')).toEqual([]);
    const found = findTimezoneHazards('const a = 1;\nconst h = d.getHours();\n', 'x.ts') as { line: number }[];
    expect(found.map((f) => f.line)).toEqual([2]);
  });
});

describe('the application source stays free of those hazards', () => {
  const root = path.resolve(__dirname, '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) files.push(p);
    }
  };
  walk(path.join(root, 'src'));
  walk(path.join(root, 'supabase', 'functions'));

  it('scans a meaningful amount of code', () => expect(files.length).toBeGreaterThan(100));

  it('has no machine-time-zone dependence in src/ or supabase/functions/', () => {
    const found = files.flatMap((f) => (findTimezoneHazards(readFileSync(f, 'utf8'), f) as { rule: string; line: number }[]).map((h) => `${path.relative(root, f)}:${h.line} ${h.rule}`));
    expect(found).toEqual([]);
  });
});
