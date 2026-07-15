/**
 * Real wall-clock implementation of the Clock port. The engine and everything
 * else read time and sleep through this, so tests can swap in a FakeClock.
 */

import { Clock } from '../core/types';

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      if (typeof t === 'object' && 'unref' in t) (t as { unref(): void }).unref();
    });
  }
}
