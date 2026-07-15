/**
 * Per-platform politeness controls: a token-bucket rate limiter enforcing a
 * minimum spacing between requests, plus jitter and exponential backoff.
 *
 * Time is read from an injected Clock; randomness from an injected function.
 * Both make the limiter fully deterministic under test.
 */

export type RandomFn = () => number; // [0,1)

export interface RateLimiterOptions {
  /** Minimum seconds between grants (the politeness floor). */
  readonly minSpacingS: number;
  /** Jitter fraction, e.g. 0.2 for ±20%. */
  readonly jitter: number;
  /** Backoff cap in seconds. */
  readonly maxBackoffS: number;
  readonly now: () => number;
  readonly random?: RandomFn;
}

export class RateLimiter {
  private nextAvailableAt = 0;
  private backoffLevel = 0;
  private readonly random: RandomFn;

  constructor(private readonly opts: RateLimiterOptions) {
    this.random = opts.random ?? Math.random;
  }

  /** Ms until a request would be granted (0 = now). */
  msUntilReady(): number {
    return Math.max(0, this.nextAvailableAt - this.opts.now());
  }

  ready(): boolean {
    return this.msUntilReady() === 0;
  }

  /**
   * Consume a slot, scheduling the next-available time using spacing (or the
   * backed-off spacing) plus jitter. Call this immediately before dispatching.
   */
  take(): void {
    const baseS =
      this.backoffLevel > 0
        ? Math.min(this.opts.minSpacingS * 2 ** this.backoffLevel, this.opts.maxBackoffS)
        : this.opts.minSpacingS;
    const jittered = this.applyJitter(baseS);
    this.nextAvailableAt = this.opts.now() + jittered * 1000;
  }

  /** Increase backoff (on 429/503/block). Returns the new spacing seconds. */
  penalize(): number {
    this.backoffLevel = Math.min(this.backoffLevel + 1, 12);
    const spacingS = Math.min(this.opts.minSpacingS * 2 ** this.backoffLevel, this.opts.maxBackoffS);
    // Push next-available out to the penalized spacing so we truly slow down.
    this.nextAvailableAt = Math.max(this.nextAvailableAt, this.opts.now() + spacingS * 1000);
    return spacingS;
  }

  /** Successful request: decay backoff toward normal. */
  reward(): void {
    if (this.backoffLevel > 0) this.backoffLevel -= 1;
  }

  get level(): number {
    return this.backoffLevel;
  }

  private applyJitter(seconds: number): number {
    if (this.opts.jitter <= 0) return seconds;
    const delta = (this.random() * 2 - 1) * this.opts.jitter; // [-j, +j)
    return Math.max(0, seconds * (1 + delta));
  }
}
