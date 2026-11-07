/**
 * VideoProvider: the app talks to this interface only. LiveKit is the production SFU; Jitsi (IFrame API)
 * is a demo fallback. Credentials come from the `video-token` edge function, which only issues them
 * inside the join window. Neither provider records: recording is done in the browser by features/consult/recording, by hand,
 * with both parties' consent.
 */
export type VideoProviderName = 'livekit' | 'jitsi';

export type VideoCredentials =
  | { provider: 'livekit'; url: string; token: string; room: string; identity: string; role: 'doctor' | 'patient'; mode: 'video' | 'audio'; closes_at: string; recording: false }
  | { provider: 'jitsi'; domain: string; room: string; display_name: string; role: 'doctor' | 'patient'; mode: 'video' | 'audio'; closes_at: string; recording: false; config: Record<string, unknown> };

export type CallState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';
export type Quality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';

export interface RemoteStatus {
  present: boolean;
  audio: boolean;
  video: boolean;
  quality: Quality;
}

export interface CallEvents {
  state: CallState;
  /** own connection quality, as measured by the SFU */
  quality: Quality;
  remote: RemoteStatus;
  /** reason for a disconnect / failure: stable, non-identifying code */
  ended: string;
}

export interface JoinOptions {
  mic: boolean;
  camera: boolean;
  audioOnly: boolean;
  micId?: string;
  cameraId?: string;
  speakerId?: string;
  /** element the provider renders the remote participant (or the Jitsi iframe) into */
  remote: HTMLElement;
  /** local self-view (LiveKit only; Jitsi shows its own) */
  local?: HTMLVideoElement | null;
}

export interface VideoCall {
  readonly provider: VideoProviderName;
  /** whether the provider renders its own self-view / controls (Jitsi iframe) */
  readonly embedsUi: boolean;
  on<K extends keyof CallEvents>(event: K, cb: (v: CallEvents[K]) => void): () => void;
  setMic(on: boolean): Promise<void>;
  setCamera(on: boolean): Promise<void>;
  /** stop sending and receiving video (bandwidth saver); audio continues */
  setAudioOnly(on: boolean): Promise<void>;
  setLocalElement(el: HTMLVideoElement | null): void;
  /**
   * The audio of this call as raw tracks (own microphone + the remote voices), for recording. Empty when the provider does not
   * expose them: the Jitsi iframe is cross-origin, so only LiveKit calls can be recorded.
   */
  audioTracks(): MediaStreamTrack[];
  disconnect(): Promise<void>;
}

export interface VideoProvider {
  readonly name: VideoProviderName;
  connect(creds: VideoCredentials, opts: JoinOptions): Promise<VideoCall>;
}

/** Tiny typed event emitter shared by the providers. */
export class Emitter {
  private handlers = new Map<string, Set<(v: unknown) => void>>();
  private last = new Map<string, unknown>();
  on<K extends keyof CallEvents>(event: K, cb: (v: CallEvents[K]) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(cb as (v: unknown) => void);
    this.handlers.set(event, set);
    if (this.last.has(event)) cb(this.last.get(event) as CallEvents[K]); // late subscribers get the current value
    return () => set.delete(cb as (v: unknown) => void);
  }
  emit<K extends keyof CallEvents>(event: K, v: CallEvents[K]) {
    this.last.set(event, v);
    this.handlers.get(event)?.forEach((cb) => cb(v));
  }
}
