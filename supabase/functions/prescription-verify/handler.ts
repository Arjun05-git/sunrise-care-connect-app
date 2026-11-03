// Public QR verification (no sign-in; deploy with verify_jwt = false). Answers ONLY validity, doctor and
// date – never the patient, diagnosis or medicines. Rate-limited per client address against code guessing.
import { corsHeaders, serviceClient } from '../_shared/http.ts';
import { CODE } from '../_shared/rx.ts';

const reply = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json', 'X-Robots-Tag': 'noindex', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } });

export default async function verify(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { ...corsHeaders(req), 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } });
  if (req.method !== 'GET' && req.method !== 'POST') return reply(req, { error: 'method_not_allowed' }, 405);
  let code = new URL(req.url).searchParams.get('code') ?? '';
  if (req.method === 'POST') code = ((await req.json().catch(() => ({}))) as { code?: string }).code ?? '';
  code = code.trim().toUpperCase();

  const svc = serviceClient();
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0]!.trim() || req.headers.get('x-real-ip') || 'unknown';
  const { data: allowed } = await svc.rpc('check_rate_limit', { p_key: `rxverify:${ip}`, p_max: 30, p_window_seconds: 600 });
  if (allowed === false) return reply(req, { error: 'rate_limited' }, 429);
  if (!CODE.test(code)) return reply(req, { status: 'not_found' });

  const { data, error } = await svc.rpc('verify_prescription', { p_code: code });
  if (error) {
    console.error('rx_verify_error', error.message);
    return reply(req, { error: 'internal_error' }, 500);
  }
  return reply(req, data);
}
