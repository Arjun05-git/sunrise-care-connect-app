import { callFunction } from '@/lib/functions';
import type { VideoCredentials, VideoProvider, VideoProviderName } from './types';

export * from './types';
export { QualityTracker, qualityBars, type QualitySummary } from './quality';

/** Asks the server to join (window + participant checks happen there) and returns provider credentials. */
export const requestVideoCredentials = (appointmentId: string) => callFunction<VideoCredentials>('video-token', { appointment_id: appointmentId });

/** Provider implementations load on demand – neither SDK is part of the main bundle. */
export async function loadProvider(name: VideoProviderName): Promise<VideoProvider> {
  return name === 'livekit' ? (await import('./livekit')).livekitProvider : (await import('./jitsi')).jitsiProvider;
}
