// LiveKit provider (livekit-client, loaded on demand – it is only needed once a call starts).
import {
  ConnectionQuality, ConnectionState, DisconnectReason, MediaDeviceFailure, Room, RoomEvent, Track, VideoPresets,
  type Participant, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication,
} from 'livekit-client';
import { Emitter, type JoinOptions, type Quality, type RemoteStatus, type VideoCall, type VideoCredentials, type VideoProvider } from './types';

const Q: Record<ConnectionQuality, Quality> = {
  [ConnectionQuality.Excellent]: 'excellent', [ConnectionQuality.Good]: 'good', [ConnectionQuality.Poor]: 'poor',
  [ConnectionQuality.Lost]: 'lost', [ConnectionQuality.Unknown]: 'unknown',
};

class LivekitCall extends Emitter implements VideoCall {
  readonly provider = 'livekit' as const;
  readonly embedsUi = false;
  private audioOnly = false;
  private cameraWanted: boolean;
  private local: HTMLVideoElement | null;
  private leaving = false;

  constructor(private room: Room, private opts: JoinOptions) {
    super();
    this.cameraWanted = opts.camera;
    this.local = opts.local ?? null;
    this.audioOnly = opts.audioOnly;
    room
      .on(RoomEvent.ConnectionStateChanged, (s) => {
        if (s === ConnectionState.Connected) this.emit('state', 'connected');
        else if (s === ConnectionState.Reconnecting || s === ConnectionState.SignalReconnecting) this.emit('state', 'reconnecting');
        else if (s === ConnectionState.Connecting) this.emit('state', 'connecting');
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (this.leaving) return;
        const code = reason === undefined ? 'unknown' : (DisconnectReason[reason] ?? 'unknown').toLowerCase();
        this.emit('ended', code);
        this.emit('state', reason === DisconnectReason.CLIENT_INITIATED ? 'disconnected' : 'failed');
      })
      .on(RoomEvent.ConnectionQualityChanged, (q: ConnectionQuality, p: Participant) => {
        if (p.isLocal) this.emit('quality', Q[q]);
        else this.remoteChanged();
      })
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => this.attachRemote(track))
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => track.detach().forEach((el) => el.remove()))
      .on(RoomEvent.TrackPublished, (pub: RemoteTrackPublication) => {
        if (pub.kind === Track.Kind.Video && this.audioOnly) pub.setSubscribed(false);
        this.remoteChanged();
      })
      .on(RoomEvent.ParticipantConnected, () => this.remoteChanged())
      .on(RoomEvent.ParticipantDisconnected, () => { this.prune(); this.remoteChanged(); })
      .on(RoomEvent.Reconnected, () => { this.prune(); this.remoteChanged(); })
      .on(RoomEvent.TrackMuted, () => this.remoteChanged())
      .on(RoomEvent.TrackUnmuted, () => this.remoteChanged())
      .on(RoomEvent.LocalTrackPublished, () => this.attachLocal())
      .on(RoomEvent.MediaDevicesError, (e: Error) => this.emit('ended', `device_${(MediaDeviceFailure.getFailure(e) ?? 'other').toString().toLowerCase()}`));
  }

  private remotePeer(): RemoteParticipant | undefined {
    return [...this.room.remoteParticipants.values()][0];
  }

  private remoteChanged() {
    const p = this.remotePeer();
    const status: RemoteStatus = p
      ? {
          present: true,
          audio: !!p.getTrackPublication(Track.Source.Microphone) && !p.getTrackPublication(Track.Source.Microphone)!.isMuted,
          video: !this.audioOnly && !!p.getTrackPublication(Track.Source.Camera) && !p.getTrackPublication(Track.Source.Camera)!.isMuted,
          quality: Q[p.connectionQuality],
        }
      : { present: false, audio: false, video: false, quality: 'unknown' };
    this.emit('remote', status);
  }

  /** Removes elements of tracks that are gone (a full reconnect re-subscribes with new tracks). */
  private prune() {
    const live = new Set<string>();
    for (const p of this.room.remoteParticipants.values())
      for (const pub of p.trackPublications.values()) if (pub.track && pub.isSubscribed) live.add(pub.trackSid);
    this.opts.remote.querySelectorAll<HTMLElement>('[data-sid]').forEach((el) => {
      if (!live.has(el.dataset.sid ?? '')) el.remove();
    });
  }

  private attachRemote(track: RemoteTrack) {
    if (track.sid && this.opts.remote.querySelector(`[data-sid="${track.sid}"]`)) return;
    const el = track.attach();
    if (track.sid) el.dataset.sid = track.sid;
    if (track.kind === Track.Kind.Video) el.className = 'h-full w-full object-contain';
    else {
      el.hidden = true;
      const sink = this.opts.speakerId;
      if (sink && 'setSinkId' in el) void (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(sink).catch(() => undefined);
    }
    this.opts.remote.appendChild(el);
    this.prune();
    this.remoteChanged();
  }

  private attachLocal() {
    const cam = this.room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (cam && this.local) cam.attach(this.local);
  }

  setLocalElement(el: HTMLVideoElement | null) {
    this.local = el;
    this.attachLocal();
  }

  async setMic(on: boolean) {
    await this.room.localParticipant.setMicrophoneEnabled(on, this.opts.micId ? { deviceId: this.opts.micId } : undefined);
  }

  async setCamera(on: boolean) {
    this.cameraWanted = on;
    if (this.audioOnly) return;
    await this.room.localParticipant.setCameraEnabled(on, this.opts.cameraId ? { deviceId: this.opts.cameraId } : undefined);
    this.attachLocal();
  }

  async setAudioOnly(on: boolean) {
    this.audioOnly = on;
    for (const p of this.room.remoteParticipants.values())
      for (const pub of p.videoTrackPublications.values()) pub.setSubscribed(!on);
    await this.room.localParticipant.setCameraEnabled(!on && this.cameraWanted);
    this.attachLocal();
    this.remoteChanged();
  }

  async disconnect() {
    this.leaving = true;
    await this.room.disconnect();
    this.opts.remote.replaceChildren();
    this.emit('state', 'disconnected');
  }
}

export const livekitProvider: VideoProvider = {
  name: 'livekit',
  async connect(creds: VideoCredentials, opts: JoinOptions) {
    if (creds.provider !== 'livekit') throw new Error('wrong_provider');
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: opts.micId },
      videoCaptureDefaults: { resolution: VideoPresets.h540.resolution, deviceId: opts.cameraId },
      audioOutput: opts.speakerId ? { deviceId: opts.speakerId } : undefined,
    });
    const call = new LivekitCall(room, opts);
    call.emit('state', 'connecting');
    try {
      await room.connect(creds.url, creds.token, { autoSubscribe: true });
    } catch (e) {
      call.emit('ended', 'connect_failed');
      call.emit('state', 'failed');
      throw e;
    }
    call.emit('state', 'connected');
    await call.setMic(opts.mic).catch(() => call.emit('ended', 'device_mic'));
    if (opts.camera && !opts.audioOnly) await call.setCamera(true).catch(() => call.emit('ended', 'device_camera'));
    for (const p of room.remoteParticipants.values()) for (const pub of p.trackPublications.values()) if (pub.track) call['attachRemote'](pub.track as RemoteTrack);
    call['remoteChanged']();
    return call;
  },
};
