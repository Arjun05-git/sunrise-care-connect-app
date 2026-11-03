/** Public runtime config (Vite env). Secrets never live in the client – the anon key is public by design (RLS protects data). */
const env = import.meta.env;
export const config = {
  mode: (env.VITE_APP_MODE === 'supabase' ? 'supabase' : 'demo') as 'demo' | 'supabase',
  /** Empty = same origin (the dev/preview server proxies /auth/v1, /rest/v1, /storage/v1). */
  supabaseUrl: (env.VITE_SUPABASE_URL as string | undefined) || (typeof window !== 'undefined' ? window.location.origin : ''),
  supabaseAnonKey: (env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '',
};
export const isDemo = config.mode === 'demo';
/** Show demo logins / banner: always in demo mode, and against a Supabase stack seeded with test OTPs. */
export const showDemoHints = isDemo || env.VITE_DEMO_HINTS === 'true';
