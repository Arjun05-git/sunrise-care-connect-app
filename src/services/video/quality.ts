import type { Quality } from './types';

const RANK: Record<Quality, number> = { lost: 0, poor: 1, good: 2, excellent: 3, unknown: 4 };

export interface QualitySummary {
  samples: number;
  worst: Quality;
  excellent: number;
  good: number;
  poor: number;
  lost: number;
}

/** Collects periodic connection-quality samples; flushed to call_logs as one aggregate per minute. */
export class QualityTracker {
  private counts = { excellent: 0, good: 0, poor: 0, lost: 0 };
  private worst: Quality = 'unknown';

  add(q: Quality) {
    if (q === 'unknown') return;
    this.counts[q]++;
    if (RANK[q] < RANK[this.worst]) this.worst = q;
  }

  get size() {
    return this.counts.excellent + this.counts.good + this.counts.poor + this.counts.lost;
  }

  /** Returns the summary since the last flush (null when empty) and starts a new window. */
  flush(): QualitySummary | null {
    if (!this.size) return null;
    const out = { samples: this.size, worst: this.worst, ...this.counts };
    this.counts = { excellent: 0, good: 0, poor: 0, lost: 0 };
    this.worst = 'unknown';
    return out;
  }
}

/** Number of filled bars (0–4) for the network-quality indicator. */
export const qualityBars = (q: Quality): number => ({ excellent: 4, good: 3, poor: 1, lost: 0, unknown: 0 })[q];
