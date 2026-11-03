import { createClient, type SupabaseClient, type SupportedStorage } from '@supabase/supabase-js';
import { Capacitor } from '@capacitor/core';
import { config } from './config';

/**
 * Inside the Android / iOS app the session (incl. the refresh token) lives in the Keychain / Android
 * Keystore instead of WebView localStorage (MASVS-STORAGE-1). A session left in localStorage by an older
 * build is moved across once. The web keeps localStorage.
 */
const nativeAuthStorage: SupportedStorage = {
  async getItem(key) {
    const { SecureStorage } = await import('@aparajita/capacitor-secure-storage');
    const v = await SecureStorage.getItem(key).catch(() => null);
    if (v != null) return v;
    const legacy = window.localStorage.getItem(key);
    if (legacy != null) { await SecureStorage.setItem(key, legacy); window.localStorage.removeItem(key); }
    return legacy;
  },
  async setItem(key, value) {
    const { SecureStorage } = await import('@aparajita/capacitor-secure-storage');
    await SecureStorage.setItem(key, value);
  },
  async removeItem(key) {
    const { SecureStorage } = await import('@aparajita/capacitor-secure-storage');
    await SecureStorage.removeItem(key);
  },
};

let client: SupabaseClient | null = null;

/** Browser Supabase client (anon key + the user's JWT). Never construct one with the service-role key. */
export function getSupabase(): SupabaseClient {
  if (!client) {
    if (!config.supabaseAnonKey) throw new Error('VITE_SUPABASE_ANON_KEY is not set');
    client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      // React Query already retries once; supabase-js retrying 3× more on top meant ~15 s of skeletons
      // before a failed screen could say so.
      db: { retry: false },
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'scc-auth', ...(Capacitor.isNativePlatform() ? { storage: nativeAuthStorage } : {}) },
    });
    // Realtime must carry the USER's JWT so RLS applies per subscriber. supabase-js only forwards it on
    // SIGNED_IN / TOKEN_REFRESHED, not for a session restored on page load (INITIAL_SESSION).
    const c = client;
    c.auth.onAuthStateChange((_event, session) => c.realtime.setAuth(session?.access_token ?? config.supabaseAnonKey));
  }
  return client;
}

/** Postgres errors raised by our RPCs carry a stable code in `message` (e.g. slot_taken). */
export function rpcErrorCode(e: unknown): string {
  const msg = (e as { message?: string } | null)?.message ?? '';
  return /^[a-z_]+$/.test(msg) ? msg : 'unknown';
}

/** Make sure Realtime uses the signed-in user's token before joining a channel. */
export async function ensureRealtimeAuth() {
  const sb = getSupabase();
  const { data } = await sb.auth.getSession();
  if (data.session) sb.realtime.setAuth(data.session.access_token);
}
