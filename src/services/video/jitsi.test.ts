import { jitsiProvider } from './jitsi';
import type { VideoCredentials } from './types';

/** Stub of the Jitsi IFrame API: records options/commands and lets the test fire events. */
class FakeApi {
  static last: FakeApi;
  commands: unknown[][] = [];
  listeners = new Map<string, (e: Record<string, unknown>) => void>();
  participants = 1;
  disposed = false;
  constructor(public domain: string, public opts: Record<string, any>) { FakeApi.last = this; }
  executeCommand(...args: unknown[]) { this.commands.push(args); }
  addListener(ev: string, cb: (e: Record<string, unknown>) => void) { this.listeners.set(ev, cb); }
  getNumberOfParticipants() { return this.participants; }
  dispose() { this.disposed = true; }
  fire(ev: string, e: Record<string, unknown> = {}) { this.listeners.get(ev)?.(e); }
}

const creds: VideoCredentials = {
  provider: 'jitsi', domain: 'meet.example.org', room: 'scc-abc', display_name: 'Anjali', role: 'patient', mode: 'video',
  closes_at: new Date().toISOString(), recording: false, config: { fileRecordingsEnabled: false, liveStreamingEnabled: false },
};

beforeEach(() => {
  const append = document.head.appendChild.bind(document.head);
  vi.spyOn(document.head, 'appendChild').mockImplementation((node: Node) => {
    const el = node as HTMLScriptElement;
    if (el.tagName === 'SCRIPT') {
      expect(el.src).toBe('https://meet.example.org/external_api.js');
      (window as unknown as { JitsiMeetExternalAPI: unknown }).JitsiMeetExternalAPI = FakeApi;
      queueMicrotask(() => el.onload?.(new Event('load')));
      return node;
    }
    return append(node);
  });
});

describe('Jitsi fallback provider', () => {
  it('joins the server-issued room with recording off and our display name', async () => {
    const remote = document.createElement('div');
    const call = await jitsiProvider.connect(creds, { mic: true, camera: false, audioOnly: true, remote });
    const o = FakeApi.last.opts;
    expect(o.roomName).toBe('scc-abc');
    expect(o.parentNode).toBe(remote);
    expect(o.userInfo).toEqual({ displayName: 'Anjali' });
    expect(o.configOverwrite).toMatchObject({ fileRecordingsEnabled: false, liveStreamingEnabled: false, startAudioOnly: true, startWithVideoMuted: true, startWithAudioMuted: false });
    expect(call.embedsUi).toBe(true);

    const states: string[] = [];
    const remotes: boolean[] = [];
    call.on('state', (s) => states.push(s));
    call.on('remote', (r) => remotes.push(r.present));
    FakeApi.last.fire('videoConferenceJoined');
    FakeApi.last.participants = 2;
    FakeApi.last.fire('participantJoined');
    expect(states.at(-1)).toBe('connected');
    expect(remotes.at(-1)).toBe(true);

    await call.setMic(false);
    await call.setMic(false); // already muted → no second toggle
    expect(FakeApi.last.commands.filter((c) => c[0] === 'toggleAudio')).toHaveLength(1);

    await call.disconnect();
    expect(FakeApi.last.commands.at(-1)).toEqual(['hangup']);
    expect(FakeApi.last.disposed).toBe(true);
  });

  it('refuses a non-hostname domain (no script injection through credentials)', async () => {
    await expect(jitsiProvider.connect({ ...creds, domain: 'evil.com/x.js?' }, { mic: true, camera: true, audioOnly: false, remote: document.createElement('div') })).rejects.toThrow('bad_domain');
  });
});
