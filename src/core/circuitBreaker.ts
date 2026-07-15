/**
 * Per-platform circuit breaker. Opens after repeated failures so we stop
 * hammering a platform that is blocking or down; probes half-open after a
 * cooldown; closes on success. Deterministic via injected clock.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly now: () => number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private openedAt = 0;

  constructor(private readonly opts: CircuitBreakerOptions) {}

  /** Whether a request may be attempted right now. */
  canRequest(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (this.opts.now() - this.openedAt >= this.opts.cooldownMs) {
        this.state = 'half-open';
        return true; // allow a single probe
      }
      return false;
    }
    // half-open: allow the probe through (one at a time is enforced by the
    // platform's serialized queue upstream).
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.state === 'half-open') {
      // Probe failed: reopen and restart cooldown.
      this.state = 'open';
      this.openedAt = this.opts.now();
      return;
    }
    if (this.failures >= this.opts.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.opts.now();
    }
  }

  get current(): CircuitState {
    return this.state;
  }

  msUntilProbe(): number {
    if (this.state !== 'open') return 0;
    return Math.max(0, this.opts.cooldownMs - (this.opts.now() - this.openedAt));
  }
}
