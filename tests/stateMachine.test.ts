import { describe, it, expect } from 'vitest';
import { AvailabilityState, SignalKind, inr } from '../src/core/types';
import { step, DEFAULT_SM_CONFIG } from '../src/core/stateMachine';
import { newTarget } from '../src/core/target';
import { obs } from './helpers/fakes';

const T0 = 1_000_000;
function target() {
  return newTarget({ id: 't1', productId: 'p1', platformId: 'blinkit', pincode: '122001', intervalS: 600, now: T0 });
}

describe('state machine — false-positive control', () => {
  it('high-confidence restock (OOS->AVAILABLE) alerts immediately', () => {
    const t = target();
    // establish OOS baseline
    step(t, obs(AvailabilityState.OUT_OF_STOCK, T0));
    const r = step(t, obs(AvailabilityState.AVAILABLE, T0 + 1000, { confidence: 0.95 }));
    expect(r.changed).toBe(true);
    expect(r.transition?.to).toBe(AvailabilityState.AVAILABLE);
    expect(r.transition?.reason).toBe('restock');
    expect(r.transition?.alertWorthy).toBe(true);
    expect(r.needsConfirmation).toBe(false);
    expect(t.lastCommercialState).toBe(AvailabilityState.AVAILABLE);
  });

  it('low-confidence AVAILABLE requires confirmation, does not alert yet', () => {
    const t = target();
    step(t, obs(AvailabilityState.OUT_OF_STOCK, T0));
    const r = step(t, obs(AvailabilityState.AVAILABLE, T0 + 1000, { confidence: 0.6 }));
    expect(r.needsConfirmation).toBe(true);
    expect(r.transition).toBeUndefined();
    expect(t.pendingAvailableConfirms).toBe(1);
    // state shown as UNKNOWN ("checking"), NOT available
    expect(t.state).toBe(AvailabilityState.UNKNOWN);
    expect(t.lastCommercialState).toBe(AvailabilityState.OUT_OF_STOCK);
  });

  it('confirmation re-check that reproduces AVAILABLE alerts', () => {
    const t = target();
    step(t, obs(AvailabilityState.OUT_OF_STOCK, T0));
    step(t, obs(AvailabilityState.AVAILABLE, T0 + 1000, { confidence: 0.6 }));
    const r = step(t, obs(AvailabilityState.AVAILABLE, T0 + 60_000, { confidence: 0.6, confirming: true }));
    expect(r.changed).toBe(true);
    expect(r.transition?.alertWorthy).toBe(true);
    expect(t.state).toBe(AvailabilityState.AVAILABLE);
  });

  it('AVAILABLE flap (available then gone on confirm) does NOT alert', () => {
    const t = target();
    step(t, obs(AvailabilityState.OUT_OF_STOCK, T0));
    // first sighting -> needs confirmation
    const r1 = step(t, obs(AvailabilityState.AVAILABLE, T0 + 1000, { confidence: 0.6 }));
    expect(r1.needsConfirmation).toBe(true);
    // confirmation contradicts -> back to OOS, no alert
    const r2 = step(t, obs(AvailabilityState.OUT_OF_STOCK, T0 + 60_000, { confirming: true }));
    expect(r2.transition?.alertWorthy).toBeFalsy();
    // no AVAILABLE alert was produced across the flap
    expect(t.lastCommercialState).toBe(AvailabilityState.OUT_OF_STOCK);
  });

  it('ambiguous/empty observation yields UNKNOWN and preserves commercial state', () => {
    const t = target();
    step(t, obs(AvailabilityState.OUT_OF_STOCK, T0));
    const r = step(t, obs(AvailabilityState.UNKNOWN, T0 + 1000));
    expect(r.changed).toBe(false);
    expect(t.state).toBe(AvailabilityState.UNKNOWN);
    expect(t.lastCommercialState).toBe(AvailabilityState.OUT_OF_STOCK);
  });

  it('UNKNOWN during confirmation cancels the pending confirmation (no alert)', () => {
    const t = target();
    step(t, obs(AvailabilityState.OUT_OF_STOCK, T0));
    step(t, obs(AvailabilityState.AVAILABLE, T0 + 1000, { confidence: 0.6 }));
    expect(t.pendingAvailableConfirms).toBe(1);
    const r = step(t, obs(AvailabilityState.UNKNOWN, T0 + 30_000));
    expect(t.pendingAvailableConfirms).toBe(0);
    expect(r.transition).toBeUndefined();
  });
});

describe('state machine — ERROR overlay', () => {
  it('ERROR never changes commercial state', () => {
    const t = target();
    step(t, obs(AvailabilityState.AVAILABLE, T0, { confidence: 0.95 }));
    const before = t.lastCommercialState;
    const r = step(t, obs(AvailabilityState.ERROR, T0 + 1000));
    expect(r.changed).toBe(false);
    expect(t.lastCommercialState).toBe(before);
    expect(t.consecutiveErrors).toBe(1);
  });

  it('error streak marks degraded once, then recovers', () => {
    const t = target();
    step(t, obs(AvailabilityState.OUT_OF_STOCK, T0));
    let degradedRaised = 0;
    for (let i = 1; i <= DEFAULT_SM_CONFIG.errorStreakToDegrade; i++) {
      const r = step(t, obs(AvailabilityState.ERROR, T0 + i * 1000));
      if (r.raiseDegraded) degradedRaised++;
    }
    expect(degradedRaised).toBe(1);
    expect(t.health).toBe('degraded');
    // a good observation clears it
    const r = step(t, obs(AvailabilityState.OUT_OF_STOCK, T0 + 100_000));
    expect(r.clearedDegraded).toBe(true);
    expect(t.health).toBe('ok');
    expect(t.consecutiveErrors).toBe(0);
  });

  it('recovery from ERROR does not fire a spurious "reappeared" alert', () => {
    const t = target();
    step(t, obs(AvailabilityState.AVAILABLE, T0, { confidence: 0.95 }));
    step(t, obs(AvailabilityState.ERROR, T0 + 1000));
    const r = step(t, obs(AvailabilityState.AVAILABLE, T0 + 2000, { confidence: 0.95 }));
    // still available, no NEW available transition
    expect(r.transition?.reason).not.toBe('restock');
    expect(t.state).toBe(AvailabilityState.AVAILABLE);
  });
});

describe('state machine — distinct states', () => {
  it('distinguishes UNAVAILABLE_IN_AREA from OUT_OF_STOCK', () => {
    const t = target();
    const r = step(
      t,
      obs(AvailabilityState.UNAVAILABLE_IN_AREA, T0, {
        signals: [{ kind: SignalKind.TEXT_AREA_UNAVAILABLE, source: 'text' }],
      }),
    );
    expect(t.lastCommercialState).toBe(AvailabilityState.UNAVAILABLE_IN_AREA);
    expect(r.transition?.alertWorthy).toBeFalsy();
  });

  it('NOT_LISTED -> COMING_SOON is alert-worthy (listing appeared)', () => {
    const t = target();
    step(t, obs(AvailabilityState.NOT_LISTED, T0));
    const r = step(t, obs(AvailabilityState.COMING_SOON, T0 + 1000));
    expect(r.transition?.alertWorthy).toBe(true);
    expect(r.transition?.reason).toBe('listing-appeared');
  });

  it('COMING_SOON -> AVAILABLE is a launch alert', () => {
    const t = target();
    step(t, obs(AvailabilityState.COMING_SOON, T0));
    const r = step(t, obs(AvailabilityState.AVAILABLE, T0 + 1000, { confidence: 0.95 }));
    expect(r.transition?.reason).toBe('launch');
    expect(r.transition?.alertWorthy).toBe(true);
  });
});

describe('state machine — price change', () => {
  it('alerts on significant price change while AVAILABLE', () => {
    const t = target();
    step(t, obs(AvailabilityState.AVAILABLE, T0, { confidence: 0.95, price: inr(134900) }));
    // small change: no alert
    const r1 = step(t, obs(AvailabilityState.AVAILABLE, T0 + 1000, { confidence: 0.95, price: inr(134950) }));
    expect(r1.transition).toBeUndefined();
    // big drop: alert
    const r2 = step(t, obs(AvailabilityState.AVAILABLE, T0 + 2000, { confidence: 0.95, price: inr(129900) }));
    expect(r2.transition?.reason).toBe('price-change');
    expect(r2.transition?.alertWorthy).toBe(true);
  });
});

describe('state machine — flap damping', () => {
  it('collapses excessive flapping into a single volatile-stock alert + cooldown', () => {
    const t = target();
    const cfg = DEFAULT_SM_CONFIG;
    let availableAlerts = 0;
    let volatileAlerts = 0;
    let ts = T0;
    // Drive many rapid available/oos flaps.
    for (let i = 0; i < 10; i++) {
      ts += 1000;
      const a = step(t, obs(AvailabilityState.AVAILABLE, ts, { confidence: 0.95 }));
      if (a.transition?.reason === 'restock' && a.transition.alertWorthy) availableAlerts++;
      if (a.transition?.reason === 'volatile-stock') volatileAlerts++;
      ts += 1000;
      step(t, obs(AvailabilityState.OUT_OF_STOCK, ts));
    }
    expect(volatileAlerts).toBeGreaterThanOrEqual(1);
    // After cooldown trips, subsequent restock alerts are suppressed within window
    expect(t.volatileCooldownUntil).toBeGreaterThan(0);
    expect(availableAlerts).toBeLessThan(cfg.flapThreshold + 2);
  });
});
