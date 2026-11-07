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
