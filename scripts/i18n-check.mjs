// Fails if any translation key used in src is missing from en.json or ml.json, or if ml lacks an en key.
// Catches t('key'), t("key"), labelKey: 'key', titleKey="key", and zod messages like 'auth.err.x' / 'validation.x'.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = [];
const walk = (d) => readdirSync(d).forEach((f) => { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) && !/\.test\./.test(f) && files.push(p); });
walk('src');
const keys = new Set();
const dyn = new Set();
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  for (const m of s.matchAll(/\bt\(\s*['"]([a-zA-Z0-9_.]+)['"]/g)) keys.add(m[1]);
  for (const m of s.matchAll(/(?:labelKey|titleKey)[:=]\s*['"]([a-zA-Z0-9_.]+)['"]/g)) keys.add(m[1]);
  for (const m of s.matchAll(/['"]((?:auth\.err|validation|patient\.v)\.[a-zA-Z_]+)['"]/g)) keys.add(m[1]);
  for (const m of s.matchAll(/\bt\(\s*`([a-zA-Z0-9_.]+)\$\{/g)) dyn.add(m[1]);
}
const flat = (o, p = '', out = {}) => { for (const [k, v] of Object.entries(o)) { const key = p ? `${p}.${k}` : k; if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out); else out[key] = v; } return out; };
const en = flat(JSON.parse(readFileSync('src/i18n/locales/en.json', 'utf8')));
const ml = flat(JSON.parse(readFileSync('src/i18n/locales/ml.json', 'utf8')));
const has = (o, k) => k in o || Object.keys(o).some((x) => x.startsWith(`${k}_`));
if (process.argv[2] === '--list') { console.log([...keys].sort().join('\n')); console.log('DYNAMIC: ' + [...dyn].join(', ')); process.exit(0); }
const missEn = [...keys].filter((k) => !has(en, k));
const missMl = Object.keys(en).filter((k) => !(k in ml));
const extraMl = Object.keys(ml).filter((k) => !(k in en));
const vars = (s) => (String(s).match(/{{\w+}}/g) ?? []).sort().join();
const varMismatch = Object.keys(en).filter((k) => k in ml && vars(en[k]) !== vars(ml[k]));
console.log(`keys used: ${keys.size} · en: ${Object.keys(en).length} · ml: ${Object.keys(ml).length} · dynamic prefixes: ${[...dyn].join(', ') || '—'}`);
for (const [label, list] of [['missing in en.json', missEn], ['missing in ml.json', missMl], ['only in ml.json', extraMl], ['interpolation mismatch', varMismatch]]) if (list.length) console.log(`✗ ${label}:\n  ${list.join('\n  ')}`);
process.exit(missEn.length || missMl.length || extraMl.length || varMismatch.length ? 1 : 0);
