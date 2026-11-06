// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
// @ts-expect-error plain JS module shared with the CLI scripts
import { scanText, shouldScan } from './lib/secret-patterns.mjs';

// Fixtures are assembled at run time so this file contains no secret-looking literal for the scanner to trip over.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (role: string) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase', role, exp: 2051222400 })}.${'s'.repeat(43)}`;
const rand = (n: number) => 'Zx9Qm2'.repeat(Math.ceil(n / 6)).slice(0, n);
const rules = (text: string, file = 'config.txt') => (scanText(text, file) as { rule: string; line: number; preview: string }[]).map((f) => f.rule);

describe('scanText – things that must never be committed or shipped', () => {
  it('flags a service-role JWT, but not the public anon key', () => {
    expect(rules(`key = ${jwt('service_role')}`)).toContain('supabase-service-role-jwt');
    expect(rules(`key = ${jwt('anon')}`)).toEqual([]);
  });

  it('flags the new-style Supabase secret key, but not the publishable one', () => {
    expect(rules(`SUPABASE_KEY=sb_${'secret'}_${rand(30)}`)).toContain('supabase-secret-key');
    expect(rules(`VITE_SUPABASE_ANON_KEY=sb_${'publishable'}_${rand(30)}`)).toEqual([]);
  });

  it('flags private keys', () => {
    expect(rules(`-----BEGIN ${'RSA PRIVATE KEY'}-----\nabc`)).toContain('private-key');
    expect(rules(`"private_key": "-----BEGIN ${'PRIVATE KEY'}-----\\nabc"`)).toContain('private-key');
  });

  it('flags live payment and cloud keys', () => {
    expect(rules(`id: rzp_${'live'}_${rand(14)}`)).toContain('razorpay-live-key');
    expect(rules(`k=sk_${'live'}_${rand(24)}`)).toContain('stripe-live-key');
    expect(rules(`AWS=AKIA${'ABCDEFGHIJKLMNOP'}`)).toContain('aws-access-key');
    expect(rules(`ghp_${rand(36)}`)).toContain('github-token');
  });

  it('flags a real-looking secret assigned to a sensitive name', () => {
    expect(rules(`LIVEKIT_API_SECRET=${rand(43)}`, '.env')).toContain('secret-assignment');
    expect(rules(`MSG91_AUTH_KEY: ${rand(32)}`, 'notes.yml')).toContain('secret-assignment');
  });

  it('flags a database URL with a real password, but not local or placeholder ones', () => {
    expect(rules(`postgres://admin:${rand(20)}@db.example-host.com:5432/app`)).toContain('database-url-password');
    expect(rules('postgresql://postgres:postgres@127.0.0.1:54322/postgres')).toEqual([]);
    expect(rules('postgres://user:<password>@host/db')).toEqual([]);
    expect(rules('postgres://user:${DB_PASSWORD}@host/db')).toEqual([]);
  });

  it('flags a VITE_ variable with a secret-looking NAME, whatever its value (it would ship in the app)', () => {
    expect(rules('VITE_SERVICE_ROLE_KEY=', '.env.example')).toContain('secret-in-client-env');
    expect(rules('VITE_RAZORPAY_KEY_SECRET=abc', '.env')).toContain('secret-in-client-env');
    expect(rules('VITE_SUPABASE_ANON_KEY=', '.env.example')).toEqual([]);
  });
});

describe('scanText – no false alarms on documented placeholders and test values', () => {
  it('ignores placeholders and empty values', () => {
    for (const v of ['', '<anon key>', '<the "anon key" from supabase status>', 'your-secret-here', 'changeme', '${LIVEKIT_API_SECRET}', 'env(SEND_SMS_HOOK_SECRET)', 'xxxxxxxxxxxxxxxxxxxxxxxx']) {
      expect(rules(`LIVEKIT_API_SECRET=${v}`, '.env.example'), v).toEqual([]);
    }
  });

  it('ignores obviously local / mock values', () => {
    expect(rules('MOCK_GATEWAY_SECRET=local-mock-gateway-secret-do-not-use', '.env.example')).toEqual([]);
    expect(rules('MOCK_WEBHOOK_SECRET=mock-webhook-signing-secret-for-tests', '.env.example')).toEqual([]);
  });

  it('honours an inline allow marker', () => {
    expect(rules(`LIVEKIT_API_SECRET=${rand(43)} # secret-scan:allow documented dev value`, '.env')).toEqual([]);
  });

  it('does not treat code that merely mentions a secret name as a leak', () => {
    expect(rules("const secret = requireEnv('LIVEKIT_API_SECRET');", 'a.ts')).toEqual([]);
    expect(rules('if (!secret) throw new Error("missing_env_SECRET");', 'a.ts')).toEqual([]);
  });
});

describe('scanText – reporting', () => {
  it('reports the line and never repeats the secret in full', () => {
    const secret = rand(43);
    const found = scanText(`line one\nLIVEKIT_API_SECRET=${secret}\n`, '.env') as { line: number; preview: string }[];
    expect(found).toHaveLength(1);
    expect(found[0]!.line).toBe(2);
    expect(found[0]!.preview).not.toContain(secret);
    expect(found[0]!.preview.length).toBeLessThan(40);
  });
});

describe('shouldScan', () => {
  it('skips binaries and lockfiles, scans source and config', () => {
    expect(shouldScan('package-lock.json')).toBe(false);
    expect(shouldScan('public/icons/icon-192.png')).toBe(false);
    expect(shouldScan('docs/screenshots/a.png')).toBe(false);
    for (const f of ['src/lib/config.ts', '.env.example', 'supabase/functions/.env.example', 'scripts/local-stack/up.sh', 'supabase/seed/demo.sql']) expect(shouldScan(f), f).toBe(true);
  });
});

describe('.gitignore keeps secret-bearing files out of the repo', () => {
  const ignored = (p: string) => spawnSync('git', ['check-ignore', '-q', p]).status === 0;
  it('ignores local env files, CLI state, key material and service accounts', () => {
    for (const p of ['.env', '.env.local', '.env.mobile', '.env.production.local', 'supabase/functions/.env', 'supabase/.temp/project-ref', 'supabase/.branches/x', 'android/app/google-services.json', 'certs/server.pem', 'certs/server.key', 'release.keystore', 'firebase-service-account.json', 'service-account.json']) {
      expect(ignored(p), p).toBe(true);
    }
  });
  it('does not ignore the committed examples', () => {
    for (const p of ['.env.example', '.env.mobile.example', 'supabase/functions/.env.example']) expect(ignored(p), p).toBe(false);
  });
});
