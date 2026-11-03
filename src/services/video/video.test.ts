import { Emitter } from './types';
import { QualityTracker, qualityBars } from './quality';

describe('QualityTracker', () => {
  it('aggregates samples per window and reports the worst', () => {
    const q = new QualityTracker();
    expect(q.flush()).toBeNull();
    ['excellent', 'good', 'unknown', 'poor', 'good'].forEach((s) => q.add(s as never));
    expect(q.flush()).toEqual({ samples: 4, worst: 'poor', excellent: 1, good: 2, poor: 1, lost: 0 });
    expect(q.flush()).toBeNull(); // a new window starts empty
    q.add('lost');
    q.add('excellent');
    expect(q.flush()).toMatchObject({ samples: 2, worst: 'lost', lost: 1 });
  });
  it('maps quality to indicator bars', () => {
    expect([qualityBars('excellent'), qualityBars('good'), qualityBars('poor'), qualityBars('lost'), qualityBars('unknown')]).toEqual([4, 3, 1, 0, 0]);
  });
});

describe('Emitter', () => {
  it('replays the latest value to late subscribers and unsubscribes', () => {
    const e = new Emitter();
    e.emit('state', 'connecting');
    const seen: string[] = [];
    const off = e.on('state', (s) => seen.push(s));
    e.emit('state', 'connected');
    off();
    e.emit('state', 'failed');
    expect(seen).toEqual(['connecting', 'connected']);
  });
});
