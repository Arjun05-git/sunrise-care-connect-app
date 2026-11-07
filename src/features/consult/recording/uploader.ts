/**
 * Uploads a recording's chunks to storage in order, one at a time. A recording is a stream: chunk N is only useful after
 * chunk N-1, so a chunk that cannot be uploaded (after retries) ends the upload instead of leaving a hole.
 * Parts are named part-000001.webm, part-000002.webm … under the prefix the server chose; they are joined for playback.
 */
export type UploadFn = (path: string, blob: Blob) => Promise<void>;
export interface DrainResult { parts: number; bytes: number; failed: boolean; /** why, when it is not a plain upload failure */ reason?: 'bad_header' }

const EBML = [0x1a, 0x45, 0xdf, 0xa3]; // every webm file starts with this

async function head(blob: Blob): Promise<number[]> {
  const part = blob.slice(0, 4);
  if (typeof part.arrayBuffer === 'function') return Array.from(new Uint8Array(await part.arrayBuffer()));
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(Array.from(new Uint8Array(r.result as ArrayBuffer))); r.onerror = () => reject(r.error); r.readAsArrayBuffer(part); });
}

const PAUSES_MS = [1_000, 3_000, 8_000];

export class ChunkUploader {
  private queue: { path: string; blob: Blob }[] = [];
  private running: Promise<void> | null = null;
  private n = 0;
  private parts = 0;
  private bytes = 0;
  private failed = false;
  private reason: DrainResult['reason'];
  private requireHeader: boolean;
  private retries: number;
  private sleep: (ms: number) => Promise<void>;

  constructor(private prefix: string, private upload: UploadFn, opts: { retries?: number; sleep?: (ms: number) => Promise<void>; requireHeader?: boolean } = {}) {
    this.requireHeader = opts.requireHeader ?? false;
    this.retries = opts.retries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  push(blob: Blob) {
    if (blob.size === 0 || this.failed) return;
    this.n += 1;
    this.queue.push({ path: `${this.prefix}part-${String(this.n).padStart(6, '0')}.webm`, blob });
    this.pump();
  }

  private pump() {
    if (this.running) return;
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.queue.length && !this.failed) this.pump();
    });
  }

  private async run() {
    while (this.queue.length && !this.failed) {
      const item = this.queue[0]!;
      // a recording whose first part has no webm header can never be played: say so now instead of saving it
      if (this.requireHeader && this.parts === 0 && !(await head(item.blob).then((h) => EBML.every((b, i) => h[i] === b)).catch(() => false))) {
        this.failed = true;
        this.reason = 'bad_header';
        this.queue.length = 0;
        break;
      }
      if (await this.send(item)) {
        this.queue.shift();
        this.parts += 1;
        this.bytes += item.blob.size;
      } else {
        this.failed = true;
        this.queue.length = 0; // nothing after a hole
      }
    }
  }

  private async send(item: { path: string; blob: Blob }) {
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        await this.upload(item.path, item.blob);
        return true;
      } catch {
        if (attempt < this.retries) await this.sleep(PAUSES_MS[Math.min(attempt, PAUSES_MS.length - 1)]!);
      }
    }
    return false;
  }

  /** Resolves when everything queued has been uploaded (or the upload has failed). */
  async drain(): Promise<DrainResult> {
    while (this.running) await this.running;
    return { parts: this.parts, bytes: this.bytes, failed: this.failed, ...(this.reason ? { reason: this.reason } : {}) };
  }
}
