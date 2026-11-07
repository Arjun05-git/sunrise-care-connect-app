import { ChunkUploader } from './uploader';

const PREFIX = 'recordings/appt-1/rec-1/';
const blob = (n: number) => new Blob([new Uint8Array(n)]);
const instantSleep = () => Promise.resolve();

describe('ChunkUploader', () => {
  it('uploads chunks in order under the recording\'s prefix, named part-000001, part-000002 …', async () => {
    const paths: string[] = [];
    const up = new ChunkUploader(PREFIX, async (path) => { paths.push(path); }, { sleep: instantSleep });
    up.push(blob(10)); up.push(blob(20)); up.push(blob(30));
    const res = await up.drain();
    expect(paths).toEqual([`${PREFIX}part-000001.webm`, `${PREFIX}part-000002.webm`, `${PREFIX}part-000003.webm`]);
    expect(res).toEqual({ parts: 3, bytes: 60, failed: false });
  });

  it('never uploads two chunks at once (order matters: a recording is a stream)', async () => {
    let running = 0; let max = 0;
    const up = new ChunkUploader(PREFIX, async () => { running++; max = Math.max(max, running); await new Promise((r) => setTimeout(r, 5)); running--; }, { sleep: instantSleep });
    for (let i = 0; i < 5; i++) up.push(blob(10));
    await up.drain();
    expect(max).toBe(1);
  });

  it('ignores empty chunks', async () => {
    const upload = vi.fn(async (_path: string, _blob: Blob) => undefined);
    const up = new ChunkUploader(PREFIX, upload, { sleep: instantSleep });
    up.push(blob(0)); up.push(blob(5));
    expect(await up.drain()).toEqual({ parts: 1, bytes: 5, failed: false });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]![0]).toBe(`${PREFIX}part-000001.webm`);
  });

  it('retries a failed chunk with a growing pause, and counts it once when it succeeds', async () => {
    let tries = 0;
    const sleeps: number[] = [];
    const up = new ChunkUploader(PREFIX, async () => { if (++tries < 3) throw new Error('network'); }, { sleep: async (ms) => { sleeps.push(ms); } });
    up.push(blob(100));
    expect(await up.drain()).toEqual({ parts: 1, bytes: 100, failed: false });
    expect(tries).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
  });

  it('gives up after the retries: reports failure and uploads nothing after the gap', async () => {
    const paths: string[] = [];
    const up = new ChunkUploader(PREFIX, async (path) => { paths.push(path); if (path.endsWith('part-000002.webm')) throw new Error('down'); }, { retries: 2, sleep: instantSleep });
    up.push(blob(10)); up.push(blob(10)); up.push(blob(10));
    const res = await up.drain();
    expect(res).toEqual({ parts: 1, bytes: 10, failed: true });
    expect(paths.filter((p) => p.endsWith('part-000003.webm'))).toHaveLength(0); // no chunk after a hole
    up.push(blob(10));
    expect((await up.drain()).failed).toBe(true);
    expect(paths.filter((p) => p.endsWith('part-000004.webm'))).toHaveLength(0);
  });

  it('drain waits for chunks that are still in flight', async () => {
    let done = 0;
    const up = new ChunkUploader(PREFIX, async () => { await new Promise((r) => setTimeout(r, 20)); done++; }, { sleep: instantSleep });
    up.push(blob(1)); up.push(blob(1));
    await up.drain();
    expect(done).toBe(2);
  });

  describe('requireHeader – a recording whose first part lacks the webm header could never be played', () => {
    const EBML = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
    it('accepts a first part that starts with the header', async () => {
      const upload = vi.fn(async () => undefined);
      const up = new ChunkUploader(PREFIX, upload, { sleep: instantSleep, requireHeader: true });
      up.push(new Blob([EBML])); up.push(blob(10));
      expect(await up.drain()).toEqual({ parts: 2, bytes: 18, failed: false });
    });

    it('refuses to continue when it does not: nothing is uploaded and the reason is reported', async () => {
      const upload = vi.fn(async () => undefined);
      const up = new ChunkUploader(PREFIX, upload, { sleep: instantSleep, requireHeader: true });
      up.push(blob(50)); up.push(blob(50));
      expect(await up.drain()).toEqual({ parts: 0, bytes: 0, failed: true, reason: 'bad_header' });
      expect(upload).not.toHaveBeenCalled();
    });

    it('only the first part is checked', async () => {
      const up = new ChunkUploader(PREFIX, async () => undefined, { sleep: instantSleep, requireHeader: true });
      up.push(new Blob([EBML])); up.push(blob(10)); up.push(blob(10));
      expect((await up.drain()).failed).toBe(false);
    });
  });

  it('drain on nothing resolves at once', async () => {
    expect(await new ChunkUploader(PREFIX, async () => undefined).drain()).toEqual({ parts: 0, bytes: 0, failed: false });
  });
});
