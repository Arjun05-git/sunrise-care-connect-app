import { describe, expect, it } from 'vitest';
import { joinParts, orderedParts } from './recording';

const names = (...n: number[]) => n.map((i) => `part-${String(i).padStart(6, '0')}.webm`);

describe('orderedParts', () => {
  it('orders parts by number, ignoring the joined file and anything else', () => {
    expect(orderedParts([...names(3, 1, 2), 'joined.webm', 'notes.txt'])).toEqual(names(1, 2, 3));
  });
  it('refuses a recording with a hole (a missing part would play as a glitch or not at all)', () => {
    expect(() => orderedParts(names(1, 2, 4))).toThrow('parts_missing');
  });
  it('refuses a recording that does not start at part 1 (the header would be missing)', () => {
    expect(() => orderedParts(names(2, 3))).toThrow('parts_missing');
  });
  it('refuses when there are no parts', () => expect(() => orderedParts(['joined.webm'])).toThrow('parts_missing'));
});

describe('joinParts', () => {
  it('concatenates the parts in order', async () => {
    const data: Record<string, number[]> = { 'p/part-000001.webm': [1, 2], 'p/part-000002.webm': [3], 'p/part-000003.webm': [4, 5] };
    const out = await joinParts('p/', names(1, 2, 3), async (path) => new Uint8Array(data[path]!));
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });
});

import { runRecordingMaintenance } from './recording';

describe('runRecordingMaintenance', () => {
  const make = (over: Partial<Parameters<typeof runRecordingMaintenance>[0]> = {}) => {
    const removed: string[][] = []; const marked: string[] = [];
    const deps = {
      expireStale: async () => 2,
      due: async () => [{ id: 'r1', prefix: 'recordings/a/r1/' }, { id: 'r2', prefix: 'recordings/a/r2/' }],
      listNames: async () => ['part-000001.webm', 'part-000002.webm', 'joined.webm'],
      remove: async (paths: string[]) => { removed.push(paths); },
      markDeleted: async (id: string) => { marked.push(id); },
      ...over,
    };
    return { deps, removed, marked };
  };

  it('fails stale recordings, removes every file under each due prefix (parts and joined), then marks the record deleted', async () => {
    const { deps, removed, marked } = make();
    expect(await runRecordingMaintenance(deps)).toEqual({ expired: 2, purged: 2, failed: 0 });
    expect(removed[0]).toEqual(['recordings/a/r1/part-000001.webm', 'recordings/a/r1/part-000002.webm', 'recordings/a/r1/joined.webm']);
    expect(marked).toEqual(['r1', 'r2']);
  });

  it('never marks a record deleted when its media could not be removed (it is retried next run)', async () => {
    const { deps, marked } = make({ remove: async (p) => { if (p[0]!.includes('/r1/')) throw new Error('storage down'); } });
    expect(await runRecordingMaintenance(deps)).toEqual({ expired: 2, purged: 1, failed: 1 });
    expect(marked).toEqual(['r2']);
  });

  it('a record refused by the database (a hold placed meanwhile) counts as failed, and the run goes on', async () => {
    const { deps } = make({ markDeleted: async (id) => { if (id === 'r1') throw new Error('legal_hold'); } });
    expect(await runRecordingMaintenance(deps)).toEqual({ expired: 2, purged: 1, failed: 1 });
  });

  it('a recording with no files left is simply marked deleted', async () => {
    const { deps, removed, marked } = make({ listNames: async () => [], due: async () => [{ id: 'r1', prefix: 'p/' }] });
    expect(await runRecordingMaintenance(deps)).toEqual({ expired: 2, purged: 1, failed: 0 });
    expect(removed).toHaveLength(0);
    expect(marked).toEqual(['r1']);
  });
});
