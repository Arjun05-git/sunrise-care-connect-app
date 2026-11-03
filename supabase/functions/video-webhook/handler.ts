// LiveKit webhook (no user JWT – deploy with verify_jwt = false). Verified with the API secret; recorded as
// server-side call logs (participant joined/left, room started/finished). Unknown rooms are ignored.
import { corsHeaders, serviceClient } from '../_shared/http.ts';
import { env } from '../_shared/env.ts';
import { verifyLivekitWebhook } from '../_shared/video/livekit.ts';

const text = (req: Request, body: string, status = 200) => new Response(body, { status, headers: corsHeaders(req) });
const EVENTS = ['room_started', 'room_finished', 'participant_joined', 'participant_left'];

interface LkEvent {
  event: string;
  room?: { name?: string };
  participant?: { identity?: string; disconnectReason?: string | number };
}

export default async function webhook(req: Request): Promise<Response> {
  if (req.method !== 'POST') return text(req, 'method_not_allowed', 405);
  const key = env('LIVEKIT_API_KEY');
  const secret = env('LIVEKIT_API_SECRET');
  if (!key || !secret) return text(req, 'not_configured', 404);
  const raw = await req.text();
  if (!(await verifyLivekitWebhook(raw, req.headers.get('authorization') ?? '', key, secret))) return text(req, 'bad_signature', 401);
  let evt: LkEvent;
  try {
    evt = JSON.parse(raw) as LkEvent;
  } catch {
    return text(req, 'bad_payload', 400);
  }
  if (!EVENTS.includes(evt.event) || !evt.room?.name) return text(req, 'ignored');
  const reason = evt.participant?.disconnectReason;
  const { error } = await serviceClient().rpc('record_video_webhook', {
    p_room: evt.room.name,
    p_event: evt.event,
    p_identity: evt.participant?.identity ?? '',
    p_detail: reason !== undefined && reason !== 0 && reason !== 'UNKNOWN_REASON' ? { reason: String(reason).slice(0, 40).toLowerCase() } : {},
  });
  if (error) {
    console.error('video_webhook_error', error.message);
    return text(req, 'error', 500);
  }
  return text(req, 'ok');
}
