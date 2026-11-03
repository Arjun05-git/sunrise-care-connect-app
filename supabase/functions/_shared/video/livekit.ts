// LiveKit access tokens and webhook verification (https://docs.livekit.io/home/get-started/authentication/).
import { safeEqual } from '../payments/crypto.ts';
import { sha256Base64, signHs256, verifyHs256 } from './jwt.ts';

export interface LivekitTokenInput {
  apiKey: string;
  apiSecret: string;
  room: string;
  identity: string;
  name: string;
  role: 'doctor' | 'patient';
  ttlSeconds: number;
}

/** Join-only grant for one room. Never grants recording, room admin or room creation outside this room. */
export function livekitGrant(room: string) {
  return { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, roomRecord: false, roomAdmin: false, roomCreate: false, hidden: false };
}

export async function livekitToken(i: LivekitTokenInput): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signHs256(
    { iss: i.apiKey, sub: i.identity, name: i.name, nbf: now - 10, exp: now + i.ttlSeconds, jti: crypto.randomUUID(), metadata: JSON.stringify({ role: i.role }), video: livekitGrant(i.room) },
    i.apiSecret,
  );
}

/**
 * LiveKit signs webhooks with a JWT in the Authorization header (issuer = API key, signed with the
 * API secret) whose `sha256` claim is the base64 SHA-256 of the raw body.
 */
export async function verifyLivekitWebhook(body: string, authorization: string, apiKey: string, apiSecret: string): Promise<boolean> {
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  if (!token) return false;
  const claims = await verifyHs256(token, apiSecret);
  if (!claims || claims.iss !== apiKey || typeof claims.sha256 !== 'string') return false;
  return safeEqual(claims.sha256, await sha256Base64(body));
}
