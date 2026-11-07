/**
 * Audio-only capture of a consultation: the doctor's microphone and the patient's voice are mixed into one stream
 * (Web Audio) and recorded as opus in webm by MediaRecorder, in slices handed to the uploader as they arrive.
 * Tracks that appear later (the patient reconnects) are mixed in; with no live audio it refuses to start.
 */
export interface CaptureDeps { AudioContext: typeof AudioContext; MediaRecorder: typeof MediaRecorder; MediaStream: typeof MediaStream }

const browserDeps = (): CaptureDeps => ({
  AudioContext: globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext,
  MediaRecorder: globalThis.MediaRecorder,
  MediaStream: globalThis.MediaStream,
});

const TYPES = ['audio/webm;codecs=opus', 'audio/webm'];
const REFRESH_MS = 3_000;

export class AudioCapture {
  /** Chrome, Edge, Firefox and Android: yes. Safari / iOS record mp4, which cannot be joined chunk by chunk: no. */
  static supported(deps: CaptureDeps = browserDeps()): boolean {
    return !!deps.AudioContext && !!deps.MediaRecorder && TYPES.some((t) => deps.MediaRecorder.isTypeSupported?.(t));
  }

  /** The type to upload with: storage compares it exactly, so no codec parameters. */
  readonly mimeType = 'audio/webm';

  private deps: CaptureDeps;
  private timeslice: number;
  private ctx: AudioContext | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private rec: MediaRecorder | null = null;
  private seen = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private getTracks: () => MediaStreamTrack[], private onChunk: (chunk: Blob) => void, opts: { deps?: CaptureDeps; timesliceMs?: number } = {}) {
    this.deps = opts.deps ?? browserDeps();
    this.timeslice = opts.timesliceMs ?? 10_000;
  }

  private live() {
    return this.getTracks().filter((t) => t.kind === 'audio' && t.readyState === 'live');
  }

  private connect(tracks: MediaStreamTrack[]) {
    if (!this.ctx || !this.dest) return;
    for (const t of tracks) {
      if (this.seen.has(t.id)) continue;
      this.seen.add(t.id);
      this.ctx.createMediaStreamSource(new this.deps.MediaStream([t])).connect(this.dest);
    }
  }

  /** Mix in any audio track that was not there at the start. */
  refreshSources() {
    this.connect(this.live());
  }

  start() {
    const tracks = this.live();
    if (!tracks.length) throw new Error('no_audio');
    this.ctx = new this.deps.AudioContext();
    void this.ctx.resume?.();
    this.dest = this.ctx.createMediaStreamDestination();
    this.connect(tracks);
    const mimeType = TYPES.find((t) => this.deps.MediaRecorder.isTypeSupported?.(t)) ?? 'audio/webm';
    this.rec = new this.deps.MediaRecorder(this.dest.stream, { mimeType, audioBitsPerSecond: 32_000 });
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) this.onChunk(e.data); };
    this.rec.start(this.timeslice);
    this.timer = setInterval(() => this.refreshSources(), REFRESH_MS);
  }

  /** Stops recording; resolves after the final slice has been handed over. Safe to call again. */
  async stop() {
    clearInterval(this.timer);
    const rec = this.rec;
    this.rec = null;
    if (!rec) return;
    if (rec.state !== 'inactive') await new Promise<void>((resolve) => { rec.onstop = () => resolve(); rec.stop(); });
    await this.ctx?.close?.();
    this.ctx = null;
    this.dest = null;
  }
}
