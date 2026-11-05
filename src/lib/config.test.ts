import { describe, expect, it } from 'vitest';
import { ConfigError, resolveConfig } from './config';

const ok = { VITE_APP_ENV: 'demo', VITE_APP_MODE: 'demo', VITE_SUPABASE_ANON_KEY: 'k' };

describe('resolveConfig – fails closed', () => {
  it('refuses a missing VITE_APP_ENV instead of guessing', () => {
    expect(() => resolveConfig({ VITE_APP_MODE: 'supabase' })).toThrow(ConfigError);
  });

  it('refuses an unknown VITE_APP_ENV', () => {
    expect(() => resolveConfig({ ...ok, VITE_APP_ENV: 'prod' })).toThrow(ConfigError);
  });

  it('refuses a missing VITE_APP_MODE instead of falling back to demo auth', () => {
    expect(() => resolveConfig({ VITE_APP_ENV: 'production' })).toThrow(ConfigError);
  });

  it('refuses an unknown VITE_APP_MODE', () => {
    expect(() => resolveConfig({ ...ok, VITE_APP_MODE: 'Supabase ' })).toThrow(ConfigError);
  });

  it('never allows demo auth in a production environment', () => {
    expect(() => resolveConfig({ ...ok, VITE_APP_ENV: 'production', VITE_APP_MODE: 'demo' })).toThrow(ConfigError);
  });

  it('never allows demo hints in a production environment', () => {
    expect(() => resolveConfig({ VITE_APP_ENV: 'production', VITE_APP_MODE: 'supabase', VITE_DEMO_HINTS: 'true' })).toThrow(ConfigError);
  });
});

describe('resolveConfig – valid combinations', () => {
  it('demo environment with built-in demo auth', () => {
    const c = resolveConfig(ok);
    expect(c).toMatchObject({ appEnv: 'demo', mode: 'demo', isDemo: true, showDemoHints: true });
  });

  it('demo environment against a seeded Supabase stack shows hints only when asked', () => {
    const base = { VITE_APP_ENV: 'demo', VITE_APP_MODE: 'supabase', VITE_SUPABASE_ANON_KEY: 'k' };
    expect(resolveConfig({ ...base, VITE_DEMO_HINTS: 'true' })).toMatchObject({ isDemo: false, showDemoHints: true });
    expect(resolveConfig(base)).toMatchObject({ isDemo: false, showDemoHints: false });
  });

  it('production environment: real auth, no demo anything', () => {
    const c = resolveConfig({ VITE_APP_ENV: 'production', VITE_APP_MODE: 'supabase', VITE_SUPABASE_ANON_KEY: 'k' });
    expect(c).toMatchObject({ appEnv: 'production', mode: 'supabase', isDemo: false, showDemoHints: false });
  });

  it('falls back to the page origin only when no Supabase URL is given', () => {
    expect(resolveConfig({ ...ok, VITE_APP_MODE: 'supabase' }, 'https://app.example').supabaseUrl).toBe('https://app.example');
    expect(resolveConfig({ ...ok, VITE_APP_MODE: 'supabase', VITE_SUPABASE_URL: 'https://x.supabase.co' }, 'https://app.example').supabaseUrl).toBe('https://x.supabase.co');
  });
});
