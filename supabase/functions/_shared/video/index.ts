// Server half of the VideoProvider abstraction: picks the provider from env and issues join credentials.
//   VIDEO_PROVIDER=livekit  → LIVEKIT_URL (wss://…), LIVEKIT_API_KEY, LIVEKIT_API_SECRET   (production)
//   otherwise               → Jitsi (JITSI_DOMAIN, default meet.jit.si)                       (demo fallback)
// Recording is never enabled: LiveKit grants roomRecord=false and Jitsi gets recording/streaming disabled.
import { env } from '../env.ts';
import { livekitToken } from './livekit.ts';

export type VideoProviderName = 'livekit' | 'jitsi';

export interface JoinResult {
  room: string;
  identity: string;
  display_name: string;
  role: 'doctor' | 'patient';
  mode: 'video' | 'audio';
  closes_at: string;
}

export type VideoCredentials =
  | { provider: 'livekit'; url: string; token: string; room: string; identity: string; role: string; mode: string; closes_at: string; recording: false }
  | { provider: 'jitsi'; domain: string; room: string; display_name: string; role: string; mode: string; closes_at: string; recording: false; config: Record<string, unknown> };

export function activeVideoProvider(): VideoProviderName {
  return env('VIDEO_PROVIDER') === 'livekit' && env('LIVEKIT_URL') && env('LIVEKIT_API_KEY') && env('LIVEKIT_API_SECRET') ? 'livekit' : 'jitsi';
}

/** Token lifetime: until the join window closes (+5 min), at least 5 and at most 120 minutes. */
export function tokenTtl(closesAt: string, now = Date.now()): number {
  const s = Math.round((new Date(closesAt).getTime() - now) / 1000) + 300;
  return Math.min(Math.max(s, 300), 7200);
}

/** Jitsi config overrides: no recording, no live streaming, no deep links to the native app, no prejoin page. */
export const JITSI_CONFIG = {
  fileRecordingsEnabled: false,
  liveStreamingEnabled: false,
  recordingService: { enabled: false, sharingEnabled: false },
  localRecording: { disable: true },
  transcription: { enabled: false },
  prejoinConfig: { enabled: false },
  prejoinPageEnabled: false,
  disableDeepLinking: true,
  disableInviteFunctions: true,
  enableWelcomePage: false,
  toolbarButtons: [],
} as const;

export async function issueCredentials(provider: VideoProviderName, j: JoinResult): Promise<VideoCredentials> {
  const base = { room: j.room, role: j.role, mode: j.mode, closes_at: j.closes_at, recording: false as const };
  if (provider === 'livekit') {
    const token = await livekitToken({
      apiKey: env('LIVEKIT_API_KEY')!, apiSecret: env('LIVEKIT_API_SECRET')!, room: j.room, identity: j.identity, name: j.display_name, role: j.role, ttlSeconds: tokenTtl(j.closes_at),
    });
    return { provider, url: env('LIVEKIT_PUBLIC_URL') ?? env('LIVEKIT_URL')!, token, identity: j.identity, ...base };
  }
  return { provider, domain: env('JITSI_DOMAIN') ?? 'meet.jit.si', display_name: j.display_name, config: { ...JITSI_CONFIG }, ...base };
}
