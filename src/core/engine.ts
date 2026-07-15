/**
 * The monitoring engine — orchestration only. It ties together the scheduler,
 * per-platform rate limiters and circuit breakers, the state machine, the dedup
 * ledger, and the alert dispatcher, over a set of injected ports. It performs
 * no I/O itself: every outside interaction (network, storage, alerting, time,
 * randomness, ids) is a dependency, which is what makes the engine
 * deterministically testable.
 *
 * Design invariants enforced here (see docs/02-architecture.md):
 *   - One in-flight request per platform (serialized per-platform processing).
 *   - Politeness: rate limiter gates every dispatch; jittered rescheduling.
 *   - Bulkhead isolation: a throw in one target/platform never breaks another.
 *   - Offline mode: no fetches, no ERROR spam, single in/out event.
 *   - Confirmation before AVAILABLE alerts (false-positive control).
 *   - Cross-restart dedup via a persisted ledger.
 */

import {
  Alert,
  AvailabilityState,
  CheckContext,
  Clock,
  DeliveryOutcome,
  Logger,
  NetworkProbe,
  Observation,
  PlatformAdapter,
  PlatformId,
  Product,
  ResolvedTarget,
  Target,
  Transition,
} from './types';
import { DEFAULT_SM_CONFIG, StateMachineConfig, step } from './stateMachine';
import { RateLimiter, RandomFn } from './rateLimiter';
import { CircuitBreaker } from './circuitBreaker';
import { nextDue, selectDueForPlatform, spreadSchedule } from './scheduler';
import { DedupLedger } from './dedup';
import { buildAlert, makeTransition } from './alertFactory';
import { errorObservation } from './confidence';

export interface EngineStorage {
  /** Persist a target's mutated schedule/machine state. */
  saveTargetState(t: Target): void;
  /** Append an observation (subject to retention). */
  recordObservation(targetId: string, obs: Observation): void;
  /**
   * Atomically commit a transition together with its alert + delivery outcomes
   * (if any). This is what guarantees restart cannot double-alert an edge.
   */
  commitTransition(
    transition: Transition,
    alert: Alert | undefined,
    deliveries: DeliveryOutcome[] | undefined,
    edgeKey: string | undefined,
  ): void;
  /** Dedup keys already dispatched (loaded on startup). */
  loadDedupKeys(): string[];
  /** Persisted resolution cache: targetId -> resolved ref/url. */
  saveResolution?(targetId: string, ref: { url?: string; platformRef?: string }): void;
}

export interface AlertDispatcher {
  dispatch(alert: Alert): Promise<DeliveryOutcome[]>;
}

export type EngineNotice =
  | { kind: 'degraded'; target: Target }
  | { kind: 'recovered'; target: Target }
  | { kind: 'needs-login'; platformId: PlatformId }
  | { kind: 'offline' }
  | { kind: 'online' };

export interface EngineDeps {
  clock: Clock;
  netProbe: NetworkProbe;
  logger: Logger;
  adapters: Map<PlatformId, PlatformAdapter>;
  storage: EngineStorage;
  dispatcher: AlertDispatcher;
  getProduct(productId: string): Product | undefined;
  random?: RandomFn;
  idGen?: () => string;
  smConfig?: StateMachineConfig;
  /** Seconds to wait before a confirmation re-check (floored by min spacing). */
  confirmDelayS?: number;
  onNotice?(notice: EngineNotice): void;
}

const PLATFORM_IDS: PlatformId[] = ['amazon', 'flipkart', 'blinkit', 'zepto', 'instamart', 'bigbasket'];

export class Engine {
  private readonly limiters = new Map<PlatformId, RateLimiter>();
  private readonly breakers = new Map<PlatformId, CircuitBreaker>();
  private readonly resolutions = new Map<string, { url?: string; platformRef?: string }>();
  private readonly dedup: DedupLedger;
  private readonly random: RandomFn;
  private readonly smConfig: StateMachineConfig;
  private readonly confirmDelayS: number;
  private idCounter = 0;
  private targets: Target[] = [];
  private running = false;
  private offline = false;
  private loopHandle: Promise<void> | null = null;

  constructor(private readonly deps: EngineDeps) {
    this.random = deps.random ?? Math.random;
    this.smConfig = deps.smConfig ?? DEFAULT_SM_CONFIG;
    this.confirmDelayS = deps.confirmDelayS ?? 45;
    this.dedup = new DedupLedger(deps.storage.loadDedupKeys());
    for (const id of PLATFORM_IDS) {
      const adapter = deps.adapters.get(id);
      if (!adapter) continue;
      const m = adapter.manifest;
      this.limiters.set(
        id,
        new RateLimiter({
          minSpacingS: m.minSpacingS,
          jitter: 0.2,
          maxBackoffS: 60 * 60,
          now: () => this.deps.clock.now(),
          random: this.random,
        }),
      );
      this.breakers.set(
        id,
        new CircuitBreaker({
          failureThreshold: 4,
          cooldownMs: 5 * 60 * 1000,
          now: () => this.deps.clock.now(),
        }),
      );
    }
  }

  private nextId(prefix: string): string {
    if (this.deps.idGen) return this.deps.idGen();
    this.idCounter += 1;
    return `${prefix}_${this.deps.clock.now().toString(36)}_${this.idCounter}`;
  }

  /** Load targets and spread their schedule (called on start/restore). */
  setTargets(targets: Target[], spread = true): void {
    this.targets = targets;
    if (spread) spreadSchedule(this.targets, this.deps.clock.now(), this.random);
  }

  getTargets(): readonly Target[] {
    return this.targets;
  }

  isOffline(): boolean {
    return this.offline;
  }

  /**
   * Process one scheduling round: for each platform, if its circuit and rate
   * limiter permit, check the most-due target. Returns the number of checks
   * performed. Safe to call repeatedly (the loop calls it on a cadence).
   */
  async tick(): Promise<number> {
    const online = await this.safeIsOnline();
    if (!online) {
      if (!this.offline) {
        this.offline = true;
        this.deps.logger.info('engine offline: connectivity lost');
        this.deps.onNotice?.({ kind: 'offline' });
      }
      return 0;
    }
    if (this.offline) {
      this.offline = false;
      this.deps.logger.info('engine online: connectivity restored, re-spreading schedule');
      spreadSchedule(this.targets, this.deps.clock.now(), this.random);
      this.deps.onNotice?.({ kind: 'online' });
    }

    const now = this.deps.clock.now();
    let checks = 0;
    for (const platformId of PLATFORM_IDS) {
      const adapter = this.deps.adapters.get(platformId);
      if (!adapter) continue;
      const breaker = this.breakers.get(platformId)!;
      const limiter = this.limiters.get(platformId)!;
      if (!breaker.canRequest() || !limiter.ready()) continue;

      const due = selectDueForPlatform(this.targets, platformId, now);
      if (due.length === 0) continue;

      // Serialize: one target per platform per tick (one in-flight request).
      const target = due[0]!.target;
      limiter.take();
      // eslint-disable-next-line no-await-in-loop
      await this.checkTarget(target, adapter);
      checks += 1;
    }
    return checks;
  }

  private async checkTarget(target: Target, adapter: PlatformAdapter): Promise<void> {
    const platformId = target.platformId;
    const breaker = this.breakers.get(platformId)!;
    const limiter = this.limiters.get(platformId)!;
    const product = this.deps.getProduct(target.productId);
    const now = this.deps.clock.now();
    const confirming = target.pendingAvailableConfirms > 0;

    let obs: Observation;
    try {
      if (!product) throw new Error(`product ${target.productId} not found`);
      const ctx: CheckContext = {
        pincode: target.pincode,
        useAuthenticatedSession: false,
        confirming,
      };
      const resolved = await this.resolve(target, product, adapter, ctx);
      const raw = await adapter.check(resolved, ctx);
      obs = { ...raw, confirming, at: raw.at || now };
      // A login wall is not a commercial signal — surface as needs-login.
      if (this.looksLikeLoginWall(obs)) {
        this.deps.onNotice?.({ kind: 'needs-login', platformId });
      }
    } catch (err) {
      obs = errorObservation({
        detail: err instanceof Error ? err.message : String(err),
        fetchedVia: 'fake',
        at: now,
        confirming,
      });
    }

    this.deps.storage.recordObservation(target.id, obs);

    // Circuit + rate-limit feedback based on the observation.
    if (obs.state === AvailabilityState.ERROR || this.looksBlocked(obs)) {
      breaker.recordFailure();
      const spacing = limiter.penalize();
      this.deps.logger.warn('platform check failed; backing off', {
        platformId,
        target: target.id,
        spacingS: spacing,
      });
    } else {
      breaker.recordSuccess();
      limiter.reward();
    }

    // Advance the state machine.
    const res = step(target, obs, this.smConfig);

    if (res.raiseDegraded) this.deps.onNotice?.({ kind: 'degraded', target });
    if (res.clearedDegraded) this.deps.onNotice?.({ kind: 'recovered', target });

    // Handle confirmation scheduling.
    if (res.needsConfirmation) {
      // Re-check soon, but never faster than the politeness floor.
      const delayS = Math.max(this.confirmDelayS, adapter.manifest.minSpacingS);
      target.nextDueAt = this.deps.clock.now() + delayS * 1000;
      target.health = target.health === 'ok' ? 'ok' : target.health;
      this.deps.storage.saveTargetState(target);
      this.deps.logger.debug('scheduling confirmation re-check', { target: target.id });
      return;
    }

    // Reschedule normally (interval possibly stretched by backoff level).
    const effectiveInterval = target.intervalS * 2 ** Math.min(limiter.level, 4);
    target.nextDueAt = nextDue(this.deps.clock.now(), effectiveInterval, 0.2, this.random);
    target.backoffLevel = limiter.level;

    if (res.transition && res.changed) {
      await this.emitTransition(target, product, obs, res.transition);
    } else {
      this.deps.storage.saveTargetState(target);
    }
  }

  private async emitTransition(
    target: Target,
    product: Product | undefined,
    obs: Observation,
    tr: { from: AvailabilityState; to: AvailabilityState; reason: Transition['reason']; alertWorthy: boolean },
  ): Promise<void> {
    const transition = makeTransition({
      id: this.nextId('tr'),
      targetId: target.id,
      from: tr.from,
      to: tr.to,
      reason: tr.reason,
      alertWorthy: tr.alertWorthy,
      observation: obs,
    });

    let alert: Alert | undefined;
    let deliveries: DeliveryOutcome[] | undefined;
    let edgeKeyStr: string | undefined;

    if (tr.alertWorthy && product) {
      const parts = {
        targetId: target.id,
        reason: tr.reason,
        toState: tr.to,
        stateEnteredAt: target.stateSince,
      };
      if (this.dedup.claim(parts)) {
        edgeKeyStr = `${parts.targetId}|${parts.reason}|${parts.toState}|${parts.stateEnteredAt}`;
        alert = buildAlert({ id: this.nextId('al'), transition, target, product });
        try {
          deliveries = await this.deps.dispatcher.dispatch(alert);
        } catch (err) {
          this.deps.logger.error('alert dispatch threw', { err: String(err), target: target.id });
          deliveries = [];
        }
        this.deps.logger.info('alert dispatched', {
          target: target.id,
          state: tr.to,
          reason: tr.reason,
        });
      } else {
        this.deps.logger.debug('duplicate edge suppressed', { target: target.id });
      }
    }

    // Atomic commit: transition + alert + deliveries + dedup key + target state.
    this.deps.storage.commitTransition(transition, alert, deliveries, edgeKeyStr);
    this.deps.storage.saveTargetState(target);
  }

  private async resolve(
    target: Target,
    product: Product,
    adapter: PlatformAdapter,
    ctx: CheckContext,
  ): Promise<ResolvedTarget> {
    // URL mode: use the configured URL directly.
    const directUrl = product.urls?.[target.platformId];
    if (product.mode === 'url' && directUrl) {
      return {
        productId: target.productId,
        platformId: target.platformId,
        pincode: target.pincode,
        url: directUrl,
        rules: product.rules,
      };
    }
    // Cached resolution from a prior search.
    const cached = this.resolutions.get(target.id);
    if (cached) {
      return {
        productId: target.productId,
        platformId: target.platformId,
        pincode: target.pincode,
        url: cached.url,
        platformRef: cached.platformRef,
        rules: product.rules,
      };
    }
    // Keyword mode: search once, pick the best candidate, cache it.
    const keyword = product.keywords?.[0] ?? product.name;
    const candidates = await adapter.search({ text: keyword, rules: product.rules }, ctx);
    const best = pickBestCandidate(candidates, product);
    if (best) {
      const ref = { url: best.url, platformRef: best.platformRef };
      this.resolutions.set(target.id, ref);
      this.deps.storage.saveResolution?.(target.id, ref);
      return {
        productId: target.productId,
        platformId: target.platformId,
        pincode: target.pincode,
        url: best.url,
        platformRef: best.platformRef,
        rules: product.rules,
      };
    }
    // No candidate: monitor as keyword (adapter will report NOT_LISTED).
    return {
      productId: target.productId,
      platformId: target.platformId,
      pincode: target.pincode,
      keyword,
      rules: product.rules,
    };
  }

  private looksBlocked(obs: Observation): boolean {
    return obs.signals.some((s) => s.kind === 'BLOCK_SIGNATURE');
  }

  private looksLikeLoginWall(obs: Observation): boolean {
    return obs.signals.some((s) => s.kind === 'LOGIN_WALL');
  }

  private async safeIsOnline(): Promise<boolean> {
    try {
      return await this.deps.netProbe.isOnline();
    } catch {
      return false;
    }
  }

  // ---- Lifecycle ----------------------------------------------------------

  async start(tickIntervalMs = 1000): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.deps.logger.info('engine started');
    this.loopHandle = this.loop(tickIntervalMs);
  }

  private async loop(tickIntervalMs: number): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        this.deps.logger.error('tick failed', { err: String(err) });
      }
      if (!this.running) break;
      // eslint-disable-next-line no-await-in-loop
      await this.deps.clock.sleep(tickIntervalMs);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopHandle) {
      await this.loopHandle;
      this.loopHandle = null;
    }
    this.deps.logger.info('engine stopped');
  }

  pauseTarget(id: string): void {
    const t = this.targets.find((x) => x.id === id);
    if (t) {
      t.enabled = false;
      this.deps.storage.saveTargetState(t);
    }
  }

  resumeTarget(id: string): void {
    const t = this.targets.find((x) => x.id === id);
    if (t) {
      t.enabled = true;
      t.nextDueAt = this.deps.clock.now();
      this.deps.storage.saveTargetState(t);
    }
  }
}

export function pickBestCandidate(
  candidates: readonly import('./types').CandidateProduct[],
  product: Product,
): import('./types').CandidateProduct | undefined {
  const rules = product.rules;
  const scored = candidates
    .filter((c) => matchesRules(c.title, rules))
    .filter((c) => {
      if (rules?.maxPriceMinor === undefined || !c.price) return true;
      return c.price.minor <= rules.maxPriceMinor;
    });
  return scored[0] ?? undefined;
}

function matchesRules(title: string, rules?: import('./types').ProductMatchRules): boolean {
  if (!rules) return true;
  const lower = title.toLowerCase();
  if (rules.mustInclude && !rules.mustInclude.every((w) => lower.includes(w.toLowerCase()))) {
    return false;
  }
  if (rules.mustExclude && rules.mustExclude.some((w) => lower.includes(w.toLowerCase()))) {
    return false;
  }
  return true;
}
