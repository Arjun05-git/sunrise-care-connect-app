import { AudioCapture, type CaptureDeps } from './capture';

// Minimal fakes of the browser APIs (jsdom has none of them). The real thing is checked in Chrome by
// `npm run e2e:recording-capture` (scripts/e2e-recording-capture.mjs).
class FakeTrack { constructor(public id: string, public readyState: 'live' | 'ended' = 'live', public kind = 'audio') {} }
class FakeStream { constructor(public tracks: FakeTrack[] = []) {} getAudioTracks() { return this.tracks; } }

function fakes(opts: { supported?: (t: string) => boolean } = {}) {
  const sources: FakeTrack[] = [];
  const log = { closed: false, recorders: [] as FakeRecorder[] };
  class Ctx {
    createMediaStreamDestination() { return { stream: new FakeStream() }; }
    createMediaStreamSource(s: FakeStream) { sources.push(s.tracks[0]!); return { connect: vi.fn() }; }
    close() { log.closed = true; return Promise.resolve(); }
    resume() { return Promise.resolve(); }
    state = 'running';
  }
  class Recorder {
    static isTypeSupported = (t: string) => (opts.supported ? opts.supported(t) : true);
    state: 'inactive' | 'recording' = 'inactive';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    timeslice: number | undefined;
    constructor(public stream: FakeStream, public options: { mimeType?: string; audioBitsPerSecond?: number }) { log.recorders.push(this as unknown as FakeRecorder); }
    start(ms?: number) { this.state = 'recording'; this.timeslice = ms; }
    emit(n: number) { this.ondataavailable?.({ data: new Blob([new Uint8Array(n)]) }); }
    stop() { this.state = 'inactive'; this.emit(7); this.onstop?.(); }
  }
  type FakeRecorder = InstanceType<typeof Recorder>;
  const deps = { AudioContext: Ctx, MediaRecorder: Recorder, MediaStream: FakeStream } as unknown as CaptureDeps;
  return { deps, sources, log, recorder: () => log.recorders[0]! };
}
const asTracks = (...t: FakeTrack[]) => () => t as unknown as MediaStreamTrack[];

describe('AudioCapture.supported', () => {
  it('needs MediaRecorder, an audio context and a webm/opus recorder', () => {
    expect(AudioCapture.supported(fakes().deps)).toBe(true);
    expect(AudioCapture.supported({ ...fakes().deps, MediaRecorder: undefined } as unknown as CaptureDeps)).toBe(false);
    expect(AudioCapture.supported({ ...fakes().deps, AudioContext: undefined } as unknown as CaptureDeps)).toBe(false);
    expect(AudioCapture.supported(fakes({ supported: () => false }).deps)).toBe(false);
  });
});

describe('AudioCapture', () => {
  it('refuses to start with no live audio: a recording of silence would be worse than none', () => {
    const f = fakes();
    expect(() => new AudioCapture(asTracks(), () => undefined, { deps: f.deps }).start()).toThrow('no_audio');
    expect(() => new AudioCapture(asTracks(new FakeTrack('x', 'ended')), () => undefined, { deps: f.deps }).start()).toThrow('no_audio');
    expect(f.log.recorders).toHaveLength(0);
  });

  it('mixes every live audio track once, skipping ended and non-audio ones', () => {
    const f = fakes();
    const cap = new AudioCapture(asTracks(new FakeTrack('mic'), new FakeTrack('patient'), new FakeTrack('old', 'ended'), new FakeTrack('cam', 'live', 'video')), () => undefined, { deps: f.deps });
    cap.start();
    expect(f.sources.map((s) => s.id)).toEqual(['mic', 'patient']);
    cap.refreshSources();
    expect(f.sources).toHaveLength(2); // no duplicates
    cap.stop();
  });

  it('picks up a track that arrives later (the patient reconnects)', () => {
    const f = fakes();
    const tracks = [new FakeTrack('mic')];
    const cap = new AudioCapture(() => tracks as unknown as MediaStreamTrack[], () => undefined, { deps: f.deps });
    cap.start();
    tracks.push(new FakeTrack('patient-2'));
    cap.refreshSources();
    expect(f.sources.map((s) => s.id)).toEqual(['mic', 'patient-2']);
    cap.stop();
  });

  it('records opus in webm in slices, at a low bit rate', () => {
    const f = fakes();
    new AudioCapture(asTracks(new FakeTrack('mic')), () => undefined, { deps: f.deps, timesliceMs: 8000 }).start();
    expect(f.recorder().options.mimeType).toBe('audio/webm;codecs=opus');
    expect(f.recorder().options.audioBitsPerSecond).toBeLessThanOrEqual(48000);
    expect(f.recorder().timeslice).toBe(8000);
  });

  it('falls back to plain audio/webm when opus is not announced', () => {
    const f = fakes({ supported: (t) => t === 'audio/webm' });
    new AudioCapture(asTracks(new FakeTrack('mic')), () => undefined, { deps: f.deps }).start();
    expect(f.recorder().options.mimeType).toBe('audio/webm');
  });

  it('hands every non-empty chunk to the uploader, and the final one on stop', async () => {
    const f = fakes();
    const chunks: number[] = [];
    const cap = new AudioCapture(asTracks(new FakeTrack('mic')), (b) => chunks.push(b.size), { deps: f.deps });
    cap.start();
    f.recorder().emit(100); f.recorder().emit(0); f.recorder().emit(50);
    await cap.stop();
    expect(chunks).toEqual([100, 50, 7]); // the empty one dropped, the final flush (7) delivered before stop resolves
  });

  it('stop closes the audio context and is safe to repeat', async () => {
    const f = fakes();
    const cap = new AudioCapture(asTracks(new FakeTrack('mic')), () => undefined, { deps: f.deps });
    cap.start();
    await cap.stop();
    expect(f.log.closed).toBe(true);
    await expect(cap.stop()).resolves.toBeUndefined();
  });

  it('the upload type is the plain container type (storage compares it exactly)', () => {
    expect(new AudioCapture(asTracks(new FakeTrack('mic')), () => undefined, { deps: fakes().deps }).mimeType).toBe('audio/webm');
  });
});
