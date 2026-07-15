import { describe, it, expect } from 'vitest';
import { DedupLedger, edgeKey } from '../src/core/dedup';
import { AvailabilityState } from '../src/core/types';

describe('dedup ledger', () => {
  const parts = {
    targetId: 't1',
    reason: 'restock' as const,
    toState: AvailabilityState.AVAILABLE,
    stateEnteredAt: 5000,
  };

  it('claims an edge once', () => {
    const l = new DedupLedger();
    expect(l.claim(parts)).toBe(true);
    expect(l.claim(parts)).toBe(false);
  });

  it('a new state entry (new stateEnteredAt) is a distinct edge', () => {
    const l = new DedupLedger();
    expect(l.claim(parts)).toBe(true);
    expect(l.claim({ ...parts, stateEnteredAt: 9000 })).toBe(true);
  });

  it('seeded keys (loaded from storage on restart) suppress re-alert', () => {
    const key = edgeKey(parts);
    const l = new DedupLedger([key]);
    expect(l.has(parts)).toBe(true);
    expect(l.claim(parts)).toBe(false);
  });
});
