// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLI = path.resolve(__dirname, 'scan-secrets.mjs');
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
// assembled at run time so this file holds no secret-looking literal
const LEAK = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase', role: 'service_role' })}.${'k'.repeat(43)}`;

let repo: string;
const git = (...args: string[]) => spawnSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
const scan = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: 'utf8' });
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), text);
};

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'scc-scan-'));
  git('init', '-q');
  write('README.md', 'clean file\n');
  git('add', '.');
  git('commit', '-q', '-m', 'clean');
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('scan-secrets CLI', () => {
  it('passes on a clean repository', () => {
    const r = scan();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no secrets found/i);
  });

  it('--staged stops a commit that contains a service-role key, and never prints the key', () => {
    write('config.js', `const key = '${LEAK}';\n`);
    git('add', 'config.js');
    const r = scan('--staged');
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('supabase-service-role-jwt');
    expect(r.stdout + r.stderr).toContain('config.js:1');
    expect(r.stdout + r.stderr).not.toContain(LEAK);
  });

  it('--staged passes once the key is removed from the staged file', () => {
    write('config.js', 'const key = process.env.KEY;\n');
    git('add', 'config.js');
    expect(scan('--staged').status).toBe(0);
  });

  it('--staged ignores a leak that is only in the working copy (it is not being committed)', () => {
    write('config.js', `const key = '${LEAK}';\n`); // modified, not staged
    expect(scan('--staged').status).toBe(0);
    write('config.js', 'const key = process.env.KEY;\n');
  });

  it('scans tracked files by default', () => {
    write('leak.env', `SUPABASE_SERVICE_ROLE_KEY=${LEAK}\n`);
    git('add', 'leak.env');
    const r = scan();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('leak.env:1');
  });

  it('--history finds a secret that was committed and later deleted', () => {
    git('commit', '-q', '-m', 'oops');
    git('rm', '-q', 'leak.env');
    git('commit', '-q', '-m', 'remove it');
    expect(scan().status).toBe(0); // gone from the tree…
    const r = scan('--history');    // …but not from history
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('leak.env');
    expect(r.stdout + r.stderr).not.toContain(LEAK);
  });

  it('a reviewed entry in .secret-scan-allow accepts an old finding, and only that one', () => {
    const preview = `eyJh…(${LEAK.length})`;
    write('.secret-scan-allow', `# reviewed: documented test fixture, not a real key\nsupabase-service-role-jwt leak.env ${preview}\nsecret-assignment leak.env ${preview}\n`);
    const r = scan('--history');
    expect(r.status).toBe(0);
    // a different secret in the same file is still caught
    write('other.env', `SUPABASE_SERVICE_ROLE_KEY=${LEAK}\n`);
    git('add', 'other.env');
    expect(scan().status).toBe(1);
    git('rm', '-q', '-f', 'other.env');
    rmSync(path.join(repo, '.secret-scan-allow'));
  });

  it('the pre-commit hook blocks a commit with a secret and lets a clean commit through', () => {
    const hooks = path.join(repo, 'scripts', 'git-hooks');
    mkdirSync(path.join(repo, 'scripts', 'lib'), { recursive: true });
    mkdirSync(hooks, { recursive: true });
    copyFileSync(CLI, path.join(repo, 'scripts', 'scan-secrets.mjs'));
    copyFileSync(path.resolve(__dirname, 'lib', 'secret-patterns.mjs'), path.join(repo, 'scripts', 'lib', 'secret-patterns.mjs'));
    copyFileSync(path.resolve(__dirname, 'git-hooks', 'pre-commit'), path.join(hooks, 'pre-commit'));
    const commit = (msg: string) => git('-c', 'core.hooksPath=scripts/git-hooks', 'commit', '-q', '-m', msg);

    write('hooked.js', `const key = '${LEAK}';\n`);
    git('add', 'scripts', 'hooked.js');
    const blocked = commit('leak');
    expect(blocked.status).not.toBe(0);
    expect(blocked.stdout + blocked.stderr).toContain('supabase-service-role-jwt');
    expect(blocked.stdout + blocked.stderr).not.toContain(LEAK);

    write('hooked.js', 'const key = process.env.KEY;\n');
    git('add', 'hooked.js');
    expect(commit('clean').status).toBe(0);
  });

  it('--dir scans a folder of build output', () => {
    write('out/app.js', `x="${LEAK}"`);
    const bad = scan('--dir', 'out');
    expect(bad.status).toBe(1);
    write('out/app.js', 'x="public"');
    expect(scan('--dir', 'out').status).toBe(0);
  });
});
