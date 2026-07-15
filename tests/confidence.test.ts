import { describe, it, expect } from 'vitest';
import { decideVerdict, buildObservation, errorObservation } from '../src/core/confidence';
import { AvailabilityState, SignalKind, Signal } from '../src/core/types';

function sig(kind: SignalKind): Signal {
  return { kind, source: 'test' };
}

describe('confidence — never guess', () => {
  it('empty evidence -> UNKNOWN with zero confidence', () => {
    const v = decideVerdict([]);
    expect(v.state).toBe(AvailabilityState.UNKNOWN);
    expect(v.confidence).toBe(0);
  });

  it('block signature dominates -> UNKNOWN even with positive signals', () => {
    const v = decideVerdict([sig(SignalKind.API_IN_STOCK), sig(SignalKind.BLOCK_SIGNATURE)]);
    expect(v.state).toBe(AvailabilityState.UNKNOWN);
  });

  it('empty-stub (Swiggy WAF) -> UNKNOWN, never OUT_OF_STOCK', () => {
    const v = decideVerdict([sig(SignalKind.AMBIGUOUS_EMPTY)]);
    expect(v.state).toBe(AvailabilityState.UNKNOWN);
    expect(v.state).not.toBe(AvailabilityState.OUT_OF_STOCK);
  });

  it('login wall -> UNKNOWN', () => {
    const v = decideVerdict([sig(SignalKind.LOGIN_WALL)]);
    expect(v.state).toBe(AvailabilityState.UNKNOWN);
  });
});

describe('confidence — commercial verdicts', () => {
  it('API in-stock -> AVAILABLE high confidence', () => {
    const v = decideVerdict([sig(SignalKind.API_IN_STOCK), sig(SignalKind.PRICE_PRESENT)]);
    expect(v.state).toBe(AvailabilityState.AVAILABLE);
    expect(v.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('API out-of-stock -> OUT_OF_STOCK high confidence', () => {
    const v = decideVerdict([sig(SignalKind.API_OUT_OF_STOCK)]);
    expect(v.state).toBe(AvailabilityState.OUT_OF_STOCK);
    expect(v.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('buy control + structured InStock agree -> AVAILABLE', () => {
    const v = decideVerdict([sig(SignalKind.BUY_CONTROL_PRESENT), sig(SignalKind.STRUCTURED_IN_STOCK)]);
    expect(v.state).toBe(AvailabilityState.AVAILABLE);
    expect(v.confidence).toBeGreaterThan(0.9);
  });

  it('conflicting strong signals -> UNKNOWN (low confidence)', () => {
    const v = decideVerdict([sig(SignalKind.API_IN_STOCK), sig(SignalKind.API_OUT_OF_STOCK)]);
    expect(v.state).toBe(AvailabilityState.UNKNOWN);
    expect(v.confidence).toBeLessThan(0.5);
  });

  it('area unavailable beats stock signals', () => {
    const v = decideVerdict([sig(SignalKind.TEXT_AREA_UNAVAILABLE), sig(SignalKind.BUY_CONTROL_ABSENT)]);
    expect(v.state).toBe(AvailabilityState.UNAVAILABLE_IN_AREA);
  });

  it('not-found-in-catalog -> NOT_LISTED', () => {
    const v = decideVerdict([sig(SignalKind.NOT_FOUND_IN_CATALOG)]);
    expect(v.state).toBe(AvailabilityState.NOT_LISTED);
  });

  it('coming soon and preorder recognised', () => {
    expect(decideVerdict([sig(SignalKind.TEXT_COMING_SOON)]).state).toBe(AvailabilityState.COMING_SOON);
    expect(decideVerdict([sig(SignalKind.TEXT_PREORDER)]).state).toBe(AvailabilityState.PREORDER);
  });

  it('temporarily unavailable recognised', () => {
    expect(decideVerdict([sig(SignalKind.TEXT_TEMPORARILY_UNAVAILABLE)]).state).toBe(
      AvailabilityState.TEMPORARILY_UNAVAILABLE,
    );
  });
});

describe('confidence — observation builders', () => {
  it('buildObservation respects override', () => {
    const o = buildObservation({
      signals: [],
      fetchedVia: 'browser-api',
      at: 1,
      overrideState: AvailabilityState.AVAILABLE,
      overrideConfidence: 0.99,
    });
    expect(o.state).toBe(AvailabilityState.AVAILABLE);
    expect(o.confidence).toBe(0.99);
  });

  it('errorObservation is ERROR with zero confidence', () => {
    const o = errorObservation({ detail: 'boom', fetchedVia: 'http', at: 1 });
    expect(o.state).toBe(AvailabilityState.ERROR);
    expect(o.confidence).toBe(0);
  });
});
