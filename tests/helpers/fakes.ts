/**
 * Deterministic test doubles for engine/core tests: a controllable clock, a
 * scripted adapter, a fake alert channel/dispatcher, an in-memory storage, a
 * seeded PRNG, and a controllable network probe.
 */

import {
  Alert,
  AlertChannel,
  AvailabilityState,
  CandidateProduct,
  CheckContext,
  Clock,
  DeliveryOutcome,
  Logger,
  NetworkProbe,
  Observation,
  PlatformAdapter,
  PlatformManifest,
  Product,
  ResolvedTarget,
  SearchQuery,
  SessionProbe,
  LocationResult,
  Signal,
  Transition,
} from '../../src/core/types';
import { AlertDispatcher, EngineStorage } from '../../src/core/engine';

/** Flush the real microtask + macrotask queue so pending .then/await chains run. */
function drain(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A clock the test advances manually. sleep() resolves against virtual time. */
export class FakeClock implements Clock {
  private t: number;
  private timers: { at: number; resolve: () => void }[] = [];

  constructor(start = 1_000_000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.timers.push({ at: this.t + ms, resolve });
    });
  }

  /**
   * Advance virtual time to now+ms, firing due sleep() timers in order. Between
   * each firing it drains the real microtask/task queue so that any *new*
   * timers scheduled as a consequence (e.g. retry backoff) are picked up before
   * we decide we're done. This makes retry/backoff flows deterministic.
   */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    await drain();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (next && next.at <= target) {
        this.timers.shift();
        this.t = Math.max(this.t, next.at);
        next.resolve();
        // eslint-disable-next-line no-await-in-loop
        await drain();
        continue;
      }
      break;
    }
    this.t = target;
    await drain();
  }

  set(t: number): void {
    this.t = t;
  }
}

/** Mulberry32 seeded PRNG for deterministic jitter/shuffle. */
export function seededRandom(seed = 12345): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class ControllableNetwork implements NetworkProbe {
  online = true;
  async isOnline(): Promise<boolean> {
    return this.online;
  }
}

export function silentLogger(): Logger {
  const noop = () => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

/**
 * A scripted adapter that returns a programmed sequence of observations (or a
 * function producing them). Records how many checks it received.
 */
export class ScriptedAdapter implements PlatformAdapter {
  readonly manifest: PlatformManifest;
  checks = 0;
  searches = 0;
  private script: (n: number, ctx: CheckContext, at: number) => Observation;
  candidates: CandidateProduct[] = [];
  sessionProbe: SessionProbe = { loggedIn: false, locationApplied: true, healthy: true };
  locationResult: LocationResult = { applied: true, serviceable: true };

  constructor(
    manifest: Partial<PlatformManifest> & Pick<PlatformManifest, 'id'>,
    script: Observation[] | ((n: number, ctx: CheckContext, at: number) => Observation),
    private readonly clock: Clock,
  ) {
    this.manifest = {
      name: manifest.id,
      runtime: 'http',
      locationStrategy: 'latlon-header',
      guestBrowsingWorks: true,
      minSpacingS: 1,
      defaultIntervalS: 10,
      alwaysConfirmAvailable: false,
      ...manifest,
    } as PlatformManifest;
    if (Array.isArray(script)) {
      const arr = script;
      this.script = (n) => arr[Math.min(n, arr.length - 1)]!;
    } else {
      this.script = script;
    }
  }

  async search(_q: SearchQuery, _ctx: CheckContext): Promise<CandidateProduct[]> {
    this.searches += 1;
    return this.candidates;
  }

  async check(_target: ResolvedTarget, ctx: CheckContext): Promise<Observation> {
    const n = this.checks;
    this.checks += 1;
    return this.script(n, ctx, this.clock.now());
  }

  async probeSession(_ctx: CheckContext): Promise<SessionProbe> {
    return this.sessionProbe;
  }

  async ensureLocation(_pincode: string, _ctx: CheckContext): Promise<LocationResult> {
    return this.locationResult;
  }
}

export function obs(
  state: AvailabilityState,
  at: number,
  extra: Partial<Observation> = {},
): Observation {
  const signals: Signal[] = extra.signals ? [...extra.signals] : [];
  return {
    state,
    confidence: extra.confidence ?? (state === AvailabilityState.AVAILABLE ? 0.95 : 0.9),
    signals,
    fetchedVia: 'fake',
    at,
    ...extra,
  };
}

export class FakeChannel implements AlertChannel {
  readonly received: Alert[] = [];
  failTimes = 0;
  private failed = 0;

  constructor(
    readonly name: AlertChannel['name'],
    readonly enabled = true,
  ) {}

  async send(alert: Alert): Promise<void> {
    if (this.failed < this.failTimes) {
      this.failed += 1;
      throw new Error(`${this.name} channel failed (attempt ${this.failed})`);
    }
    this.received.push(alert);
  }
}

/** Records dispatched alerts; returns 'sent' outcomes for one channel. */
export class RecordingDispatcher implements AlertDispatcher {
  readonly alerts: Alert[] = [];
  async dispatch(alert: Alert): Promise<DeliveryOutcome[]> {
    this.alerts.push(alert);
    return [{ channel: 'desktop', status: 'sent', attempts: 1, at: alert.at }];
  }
}

export class InMemoryStorage implements EngineStorage {
  readonly observations: { targetId: string; obs: Observation }[] = [];
  readonly transitions: Transition[] = [];
  readonly alerts: Alert[] = [];
  readonly resolutions = new Map<string, { url?: string; platformRef?: string }>();
  private dedupKeys = new Set<string>();

  constructor(seedDedupKeys: string[] = []) {
    for (const k of seedDedupKeys) this.dedupKeys.add(k);
  }

  saveTargetState(): void {
    /* targets are mutated in place; nothing to persist for the in-memory case */
  }

  recordObservation(targetId: string, o: Observation): void {
    this.observations.push({ targetId, obs: o });
  }

  commitTransition(
    transition: Transition,
    alert: Alert | undefined,
    _deliveries: DeliveryOutcome[] | undefined,
    edgeKey: string | undefined,
  ): void {
    this.transitions.push(transition);
    if (alert) this.alerts.push(alert);
    if (edgeKey) this.dedupKeys.add(edgeKey);
  }

  loadDedupKeys(): string[] {
    return [...this.dedupKeys];
  }

  saveResolution(targetId: string, ref: { url?: string; platformRef?: string }): void {
    this.resolutions.set(targetId, ref);
  }
}

export function makeProduct(over: Partial<Product> = {}): Product {
  return {
    id: over.id ?? 'p1',
    name: over.name ?? 'iPhone 17 Pro Max',
    mode: over.mode ?? 'url',
    enabled: over.enabled ?? true,
    urls: over.urls ?? { blinkit: 'https://blinkit.com/prn/x/prid/1' },
    keywords: over.keywords,
    rules: over.rules,
    group: over.group,
  };
}
