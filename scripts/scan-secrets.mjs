#!/usr/bin/env node
// Secret scanner for this repository. Findings show the file, line, rule and the first 4 characters only.
//   npm run scan:secrets                  tracked files in the working tree
//   npm run scan:secrets -- --staged      what is about to be committed (the pre-commit hook runs this)
//   npm run scan:secrets -- --history     every line ever added in git history (finds secrets deleted later)
//   npm run scan:secrets -- --dir dist    a folder of build output (high-confidence token rules only)
// Exit code 1 when anything is found. To accept a documented non-secret value put `secret-scan:allow` on its line.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { scanText, shouldScan } from './lib/secret-patterns.mjs';

const args = process.argv.slice(2);
const dirIdx = args.indexOf('--dir');
const mode = args.includes('--staged') ? 'staged' : args.includes('--history') ? 'history' : dirIdx >= 0 ? 'dir' : 'tracked';

const git = (a) => spawnSync('git', a, { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 });
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);
const findings = [];
let scanned = 0;
const scanBuffer = (buf, file, opts) => {
  if (isBinary(buf)) return;
  scanned++;
  findings.push(...scanText(buf.toString('utf8'), file, opts));
};

if (mode === 'tracked') {
  const files = git(['ls-files', '-z']).stdout.toString('utf8').split('\0').filter(Boolean);
  for (const f of files) if (shouldScan(f) && fs.existsSync(f) && fs.statSync(f).isFile()) scanBuffer(fs.readFileSync(f), f);
} else if (mode === 'staged') {
  const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).stdout.toString('utf8').split('\0').filter(Boolean);
  for (const f of files) if (shouldScan(f)) scanBuffer(git(['show', `:${f}`]).stdout, f);
} else if (mode === 'dir') {
  const root = args[dirIdx + 1];
  if (!root || !fs.existsSync(root)) {
    console.error('usage: scan-secrets --dir <folder>');
    process.exit(2);
  }
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (shouldScan(p)) scanBuffer(fs.readFileSync(p), p.replace(/\\/g, '/'), { bundle: true });
    }
  })(root);
} else {
  // history: look only at lines each commit ADDED, so a secret removed later is still found
  const log = git(['log', '--all', '-p', '-U0', '--no-color', '--format=@@commit %h']).stdout.toString('utf8');
  let commit = '';
  let file = '';
  let lineNo = 0;
  const seen = new Set();
  for (const line of log.split('\n')) {
    if (line.startsWith('@@commit ')) commit = line.slice(9).trim();
    else if (line.startsWith('+++ ')) file = line.startsWith('+++ b/') ? line.slice(6) : '';
    else if (line.startsWith('@@ ')) lineNo = Number(/\+(\d+)/.exec(line)?.[1] ?? 0) - 1;
    else if (line.startsWith('+') && file && shouldScan(file)) {
      lineNo++;
      for (const f of scanText(line.slice(1), `${file}@${commit}`)) {
        const key = `${f.rule}|${file}|${f.preview}`;
        if (!seen.has(key)) {
          seen.add(key);
          findings.push({ ...f, line: lineNo });
        }
      }
    } else if (!line.startsWith('-') && !line.startsWith('\\')) lineNo++;
  }
  scanned = 1;
}

// Reviewed baseline: `.secret-scan-allow` lists accepted findings, one per line: `<rule> <file> <preview>` (# = comment).
// It exists for findings in git history, which cannot be edited. Each entry needs a comment saying why it is safe.
const accepted = new Set();
if (fs.existsSync('.secret-scan-allow')) {
  for (const raw of fs.readFileSync('.secret-scan-allow', 'utf8').split(/\r?\n/)) {
    const [rule, file, ...rest] = raw.trim().split(/\s+/);
    if (rule && !rule.startsWith('#') && file && rest.length) accepted.add(`${rule}|${file}|${rest.join(' ')}`);
  }
}
const isAccepted = (f) => accepted.has(`${f.rule}|${f.file.replace(/@[0-9a-f]+$/, '')}|${f.preview}`);
for (let i = findings.length - 1; i >= 0; i--) if (isAccepted(findings[i])) findings.splice(i, 1);

if (findings.length) {
  console.log(`✗ ${findings.length} potential secret(s) found (${mode}):`);
  for (const f of findings) console.log(`  ${f.file}:${f.line}  ${f.rule}  ${f.preview}`);
  console.log('\nRemove the value and keep it in the platform secret store (see docs/SECURITY.md → Secrets).');
  console.log('If it was ever pushed or shared, treat it as leaked and rotate it. A documented non-secret can be marked with `secret-scan:allow` on its line.');
  process.exit(1);
}
console.log(`✓ no secrets found (${mode}${mode === 'history' ? '' : `, ${scanned} files scanned`})`);
