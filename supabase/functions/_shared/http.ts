// Shared HTTP helpers for edge functions: CORS + security headers, JSON errors, auth'd clients.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env, requireEnv } from './env.ts';
import { safeEqual } from './payments/crypto.ts';

export function corsHeaders(req: Request): Record<string, string> {
  // Set ALLOWED_ORIGINS (comma-separated) in production. Unset = '*' (auth is a bearer header, never a cookie),
  // but the caller's origin is no longer echoed back.
  const allowed = (env('ALLOWED_ORIGINS') ?? '*').split(',').map((o) => o.trim());
  const origin = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0]!,
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Expose-Headers': 'content-disposition',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}

export const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } });

/** Errors carry a stable code only – never internals, request bodies or PHI. */
export const fail = (req: Request, code: string, status = 400) => json(req, { error: code }, status);

export class HttpError extends Error {
  constructor(public code: string, public status = 400) {
    super(code);
  }
}

export function serviceClient(): SupabaseClient {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Client acting as the caller: every query and RPC is subject to RLS / the RPC's own checks. */
export function userClient(req: Request): SupabaseClient {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
}

export async function requireUser(req: Request) {
  const client = userClient(req);
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new HttpError('unauthorized', 401);
  return { client, user: data.user };
}

export const isServiceCall = (req: Request) => {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  return !!key && safeEqual(req.headers.get('Authorization') ?? '', `Bearer ${key}`);   // constant time
};

/** Postgres RPC errors raise stable codes (e.g. hold_expired); anything else becomes a generic error. */
export function rpcCode(e: { message?: string } | null): string {
  return e?.message && /^[a-z_]+$/.test(e.message) ? e.message : 'internal_error';
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError('invalid_input');
  }
}

export function handler(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
    if (req.method !== 'POST') return fail(req, 'method_not_allowed', 405);
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof HttpError) return fail(req, e.code, e.status);
      console.error('fn_error', (e as Error).message); // message only – no request bodies
      return fail(req, 'internal_error', 500);
    }
  };
}
