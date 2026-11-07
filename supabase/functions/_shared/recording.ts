/** Recording playback helpers: a recording is stored as numbered parts (part-000001.webm …) that are joined, in order, for playback. */
const PART = /^part-(\d{6})\.webm$/;

/** The parts of a recording in order. Throws 'parts_missing' unless they are exactly 1..n with no hole. */
export function orderedParts(names: string[]): string[] {
  const parts = names.filter((n) => PART.test(n)).sort();
  if (!parts.length || parts.some((n, i) => Number(PART.exec(n)![1]) !== i + 1)) throw new Error('parts_missing');
  return parts;
}

export async function joinParts(prefix: string, parts: string[], read: (path: string) => Promise<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (const p of parts) chunks.push(await read(prefix + p));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export interface MaintenanceDeps {
  expireStale: () => Promise<number>;
  due: () => Promise<{ id: string; prefix: string }[]>;
  listNames: (prefix: string) => Promise<string[]>;
  remove: (paths: string[]) => Promise<void>;
  markDeleted: (id: string) => Promise<void>;
}

/** Fails stale recordings, then purges the recordings past retention: media first, record second, one at a time so one failure never stops the rest. */
export async function runRecordingMaintenance(d: MaintenanceDeps): Promise<{ expired: number; purged: number; failed: number }> {
  const expired = await d.expireStale();
  let purged = 0;
  let failed = 0;
  for (const rec of await d.due()) {
    try {
      const names = await d.listNames(rec.prefix);
      if (names.length) await d.remove(names.map((n) => rec.prefix + n));
      await d.markDeleted(rec.id);
      purged += 1;
    } catch {
      failed += 1; // retried on the next run
    }
  }
  return { expired, purged, failed };
}
