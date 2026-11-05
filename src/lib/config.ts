/**
 * Public runtime config (Vite env). Secrets never live in the client – the anon key is public by design (RLS protects data).
 *
 * Two explicit settings, both required (a missing or unknown value is an error, never a silent default):
 *   VITE_APP_ENV   demo | production   what this build IS. Only `demo` builds contain demo code and demo logins.
 *   VITE_APP_MODE  demo | supabase     demo = built-in fake auth, no database (UI shell); supabase = real backend.
 * A production environment must use supabase mode and can never show demo hints.
 */
export type AppEnv = 'demo' | 'production';
export type AppMode = 'demo' | 'supabase';

export interface RawEnv {
  VITE_APP_ENV?: string;
  VITE_APP_MODE?: string;
  VITE_DEMO_HINTS?: string;
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_ANON_KEY?: string;
}

export interface AppConfig {
  appEnv: AppEnv;
  mode: AppMode;
  /** Empty = same origin (the dev/preview server proxies /auth/v1, /rest/v1, /storage/v1). */
  supabaseUrl: string;
  supabaseAnonKey: string;
  isDemo: boolean;
  showDemoHints: boolean;
}

export class ConfigError extends Error {}

export function resolveConfig(env: RawEnv, origin = ''): AppConfig {
  const appEnv = env.VITE_APP_ENV;
  if (appEnv !== 'demo' && appEnv !== 'production') throw new ConfigError('VITE_APP_ENV must be "demo" or "production"');
  const mode = env.VITE_APP_MODE;
  if (mode !== 'demo' && mode !== 'supabase') throw new ConfigError('VITE_APP_MODE must be "demo" or "supabase"');
  if (appEnv === 'production' && mode !== 'supabase') throw new ConfigError('A production build cannot use VITE_APP_MODE=demo');
  const hints = env.VITE_DEMO_HINTS === 'true';
  if (appEnv === 'production' && hints) throw new ConfigError('A production build cannot set VITE_DEMO_HINTS=true');
  return {
    appEnv,
    mode,
    supabaseUrl: env.VITE_SUPABASE_URL || origin,
    supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY ?? '',
    isDemo: mode === 'demo',
    showDemoHints: appEnv === 'demo' && (mode === 'demo' || hints),
  };
}

/**
 * Compile-time switch: the bundler replaces this with a literal, so everything behind it (the demo auth
 * service, demo credentials, the test-gateway checkout) is removed from production builds.
 * `npm run check:bundle` proves it.
 */
export const DEMO_BUILD = import.meta.env.VITE_APP_ENV === 'demo';

/** Set when the environment is invalid; main.tsx shows it instead of starting the app. */
export let configError: string | null = null;

// Invalid settings never fall back to demo: the locked-down values below are what a broken build runs with.
let resolved: AppConfig;
try {
  resolved = resolveConfig(import.meta.env as RawEnv, typeof window !== 'undefined' ? window.location.origin : '');
} catch (e) {
  configError = e instanceof ConfigError ? e.message : 'Invalid configuration';
  resolved = { appEnv: 'production', mode: 'supabase', supabaseUrl: '', supabaseAnonKey: '', isDemo: false, showDemoHints: false };
}

export const config = resolved;
export const isDemo = DEMO_BUILD && resolved.isDemo;
/** Show demo logins / banner: demo environments only. */
export const showDemoHints = DEMO_BUILD && resolved.showDemoHints;
