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
