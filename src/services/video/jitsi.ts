// Jitsi Meet fallback (IFrame API) – for demos only. The public meet.jit.si server requires a signed-in
// moderator and limits embedded calls; use a self-hosted Jitsi (JITSI_DOMAIN) for anything longer.
// Recording, live streaming and invites are disabled in the config the server sends.
import { Emitter, type JoinOptions, type VideoCall, type VideoCredentials, type VideoProvider } from './types';

interface JitsiApi {
  executeCommand(cmd: string, ...args: unknown[]): void;
  addListener(ev: string, cb: (e: Record<string, unknown>) => void): void;
  getNumberOfParticipants(): number;
  dispose(): void;
}
type JitsiCtor = new (domain: string, opts: Record<string, unknown>) => JitsiApi;

const loaded = new Map<string, Promise<JitsiCtor>>();
function loadApi(domain: string): Promise<JitsiCtor> {
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(domain)) return Promise.reject(new Error('bad_domain'));
  if (!loaded.has(domain))
    loaded.set(domain, new Promise((resolve, reject) => {
      const s = Object.assign(document.createElement('script'), { src: `https://${domain}/external_api.js`, async: true });
      s.onload = () => {
        const ctor = (window as unknown as { JitsiMeetExternalAPI?: JitsiCtor }).JitsiMeetExternalAPI;
        if (ctor) resolve(ctor);
        else reject(new Error('jitsi_unavailable'));
      };
      s.onerror = () => { loaded.delete(domain); reject(new Error('jitsi_unavailable')); };
      document.head.appendChild(s);
    }));
  return loaded.get(domain)!;
}

class JitsiCall extends Emitter implements VideoCall {
  readonly provider = 'jitsi' as const;
  readonly embedsUi = true;
  private mic: boolean;
  private camera: boolean;
  private leaving = false;

  constructor(private api: JitsiApi, opts: JoinOptions) {
    super();
    this.mic = opts.mic;
    this.camera = opts.camera && !opts.audioOnly;
    const remote = () => {
      const present = api.getNumberOfParticipants() > 1;
      this.emit('remote', { present, audio: present, video: present, quality: 'unknown' });
    };
    api.addListener('videoConferenceJoined', () => { this.emit('state', 'connected'); remote(); });
    api.addListener('participantJoined', remote);
    api.addListener('participantLeft', remote);
    api.addListener('audioMuteStatusChanged', (e) => { this.mic = !e.muted; });
    api.addListener('videoMuteStatusChanged', (e) => { this.camera = !e.muted; });
    api.addListener('videoConferenceLeft', () => { if (!this.leaving) { this.emit('ended', 'left'); this.emit('state', 'disconnected'); } });
    api.addListener('readyToClose', () => { if (!this.leaving) this.emit('state', 'disconnected'); });
    api.addListener('cameraError', () => this.emit('ended', 'device_camera'));
    api.addListener('micError', () => this.emit('ended', 'device_mic'));
    api.addListener('errorOccurred', (e) => { if ((e.error as { isFatal?: boolean } | undefined)?.isFatal) { this.emit('ended', 'provider_error'); this.emit('state', 'failed'); } });
    // Jitsi exposes no SFU quality metric through the IFrame API
    this.emit('quality', 'unknown');
  }

  // Jitsi only offers toggles: track the expected state now (mute events reconcile it later)
  async setMic(on: boolean) {
    if (on === this.mic) return;
    this.mic = on;
    this.api.executeCommand('toggleAudio');
  }
  async setCamera(on: boolean) {
    if (on === this.camera) return;
    this.camera = on;
    this.api.executeCommand('toggleVideo');
  }
  async setAudioOnly(on: boolean) {
    this.api.executeCommand('setAudioOnly', on);
    if (on) await this.setCamera(false);
  }
  setLocalElement() {}
  async disconnect() {
    this.leaving = true;
    try { this.api.executeCommand('hangup'); } catch { /* already gone */ }
    this.api.dispose();
    this.emit('state', 'disconnected');
  }
}

export const jitsiProvider: VideoProvider = {
  name: 'jitsi',
  async connect(creds: VideoCredentials, opts: JoinOptions) {
    if (creds.provider !== 'jitsi') throw new Error('wrong_provider');
    const Api = await loadApi(creds.domain);
    opts.remote.replaceChildren();
    const api = new Api(creds.domain, {
      roomName: creds.room,
      parentNode: opts.remote,
      width: '100%',
      height: '100%',
      userInfo: { displayName: creds.display_name },
      configOverwrite: { ...creds.config, startWithAudioMuted: !opts.mic, startWithVideoMuted: !opts.camera || opts.audioOnly, startAudioOnly: opts.audioOnly },
      interfaceConfigOverwrite: { SHOW_JITSI_WATERMARK: false, SHOW_BRAND_WATERMARK: false, MOBILE_APP_PROMO: false },
      devices: { audioInput: opts.micId, videoInput: opts.cameraId, audioOutput: opts.speakerId },
    });
    const call = new JitsiCall(api, opts);
    call.emit('state', 'connecting');
    return call;
  },
};
