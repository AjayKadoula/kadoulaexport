import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../src/core/rateLimiter';
import { CircuitBreaker } from '../src/core/circuitBreaker';
import { selectDueForPlatform, spreadSchedule, nextDue } from '../src/core/scheduler';
import { newTarget } from '../src/core/target';
import { seededRandom } from './helpers/fakes';

describe('rate limiter', () => {
  it('enforces minimum spacing', () => {
    let t = 0;
    const rl = new RateLimiter({ minSpacingS: 60, jitter: 0, maxBackoffS: 3600, now: () => t });
    expect(rl.ready()).toBe(true);
    rl.take();
    expect(rl.ready()).toBe(false);
    t += 59_000;
    expect(rl.ready()).toBe(false);
    t += 1_000;
    expect(rl.ready()).toBe(true);
  });

  it('backoff increases spacing exponentially and rewards decay it', () => {
    let t = 0;
    const rl = new RateLimiter({ minSpacingS: 10, jitter: 0, maxBackoffS: 3600, now: () => t });
    const s1 = rl.penalize();
    const s2 = rl.penalize();
    expect(s2).toBeGreaterThan(s1);
    rl.reward();
    expect(rl.level).toBe(1);
  });

  it('backoff is capped', () => {
    let t = 0;
    const rl = new RateLimiter({ minSpacingS: 10, jitter: 0, maxBackoffS: 100, now: () => t });
    for (let i = 0; i < 20; i++) rl.penalize();
    // spacing cannot exceed cap
    expect(rl.msUntilReady()).toBeLessThanOrEqual(100_000);
  });

  it('jitter stays within bounds', () => {
    let t = 0;
    const rnd = seededRandom(7);
    const rl = new RateLimiter({ minSpacingS: 100, jitter: 0.2, maxBackoffS: 3600, now: () => t, random: rnd });
    for (let i = 0; i < 50; i++) {
      t = 10_000_000 * (i + 1);
      rl.take();
      const wait = rl.msUntilReady() / 1000;
      expect(wait).toBeGreaterThanOrEqual(80);
      expect(wait).toBeLessThanOrEqual(120);
    }
  });
});

describe('circuit breaker', () => {
  it('opens after threshold, half-opens after cooldown, closes on success', () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => t });
    expect(cb.canRequest()).toBe(true);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.current).toBe('open');
    expect(cb.canRequest()).toBe(false);
    t += 1000;
    expect(cb.canRequest()).toBe(true); // half-open probe allowed
    expect(cb.current).toBe('half-open');
    cb.recordSuccess();
    expect(cb.current).toBe('closed');
  });

  it('failed probe reopens', () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => t });
    cb.recordFailure();
    expect(cb.current).toBe('open');
    t += 1000;
    cb.canRequest(); // -> half-open
    cb.recordFailure(); // probe fails
    expect(cb.current).toBe('open');
  });
});

describe('scheduler', () => {
  const now = 1_000_000;

  it('selects only due, enabled targets for the platform, most-overdue first', () => {
    const a = newTarget({ id: 'a', productId: 'p', platformId: 'amazon', pincode: '1', intervalS: 60, now });
    const b = newTarget({ id: 'b', productId: 'p', platformId: 'amazon', pincode: '1', intervalS: 60, now });
    const c = newTarget({ id: 'c', productId: 'p', platformId: 'flipkart', pincode: '1', intervalS: 60, now });
    a.nextDueAt = now - 5000;
    b.nextDueAt = now - 10_000;
    c.nextDueAt = now - 1000;
    const due = selectDueForPlatform([a, b, c], 'amazon', now);
    expect(due.map((d) => d.target.id)).toEqual(['b', 'a']);
  });

  it('groups by pincode to minimise location switching', () => {
    const mk = (id: string, pin: string, overdue: number) => {
      const t = newTarget({ id, productId: 'p', platformId: 'blinkit', pincode: pin, intervalS: 60, now });
      t.nextDueAt = now - overdue;
      return t;
    };
    // pin A has the most-overdue member, so its group comes first, then pin B
    const a1 = mk('a1', 'A', 9000);
    const a2 = mk('a2', 'A', 2000);
    const b1 = mk('b1', 'B', 8000);
    const due = selectDueForPlatform([a2, b1, a1], 'blinkit', now);
    const ids = due.map((d) => d.target.id);
    // A group (a1,a2) fully before B group (b1)
    expect(ids.indexOf('a2')).toBeLessThan(ids.indexOf('b1'));
    expect(ids[0]).toBe('a1');
  });

  it('spreadSchedule distributes due times within the interval window (no stampede)', () => {
    const rnd = seededRandom(3);
    const targets = Array.from({ length: 20 }, (_, i) =>
      newTarget({ id: `t${i}`, productId: 'p', platformId: 'zepto', pincode: '1', intervalS: 600, now }),
    );
    spreadSchedule(targets, now, rnd);
    const times = targets.map((t) => t.nextDueAt - now);
    const maxDelay = Math.max(...times);
    const minDelay = Math.min(...times);
    expect(minDelay).toBeGreaterThanOrEqual(0);
    expect(maxDelay).toBeLessThanOrEqual(600 * 1000);
    // Not all identical (they are spread)
    expect(new Set(times).size).toBeGreaterThan(10);
  });

  it('nextDue applies bounded jitter', () => {
    const rnd = seededRandom(9);
    for (let i = 0; i < 20; i++) {
      const due = nextDue(now, 600, 0.2, rnd) - now;
      expect(due).toBeGreaterThanOrEqual(600 * 0.8 * 1000);
      expect(due).toBeLessThanOrEqual(600 * 1.2 * 1000);
    }
  });
});
