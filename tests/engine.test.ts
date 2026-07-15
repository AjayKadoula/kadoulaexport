import { describe, it, expect } from 'vitest';
import { Engine, EngineDeps, EngineNotice } from '../src/core/engine';
import { AvailabilityState, CheckContext, Observation, PlatformId, SignalKind } from '../src/core/types';
import { newTarget } from '../src/core/target';
import {
  FakeClock,
  ControllableNetwork,
  ScriptedAdapter,
  RecordingDispatcher,
  InMemoryStorage,
  seededRandom,
  silentLogger,
  obs,
  makeProduct,
} from './helpers/fakes';

type Script = Observation[] | ((n: number, ctx: CheckContext, at: number) => Observation);

function setup(
  script: Script,
  opts: { product?: ReturnType<typeof makeProduct>; seedDedup?: string[]; minSpacingS?: number } = {},
) {
  const clock = new FakeClock();
  const net = new ControllableNetwork();
  const product = opts.product ?? makeProduct();
  const adapter = new ScriptedAdapter(
    { id: 'blinkit', minSpacingS: opts.minSpacingS ?? 1, defaultIntervalS: 10 },
    script,
    clock,
  );
  const storage = new InMemoryStorage(opts.seedDedup ?? []);
  const dispatcher = new RecordingDispatcher();
  const notices: EngineNotice[] = [];
  const deps: EngineDeps = {
    clock,
    netProbe: net,
    logger: silentLogger(),
    adapters: new Map<PlatformId, ScriptedAdapter>([['blinkit', adapter]]),
    storage,
    dispatcher,
    getProduct: (id) => (id === product.id ? product : undefined),
    random: seededRandom(42),
    confirmDelayS: 30,
    onNotice: (n) => notices.push(n),
  };
  const engine = new Engine(deps);
  const target = newTarget({
    id: 't1',
    productId: product.id,
    platformId: 'blinkit',
    pincode: '122001',
    intervalS: 10,
    now: clock.now(),
  });
  return { clock, net, adapter, storage, dispatcher, notices, engine, target, product };
}

describe('engine — end-to-end monitoring', () => {
  it('OOS then restock produces exactly one alert (high confidence, no confirm needed)', async () => {
    const { engine, target, clock, dispatcher, adapter } = setup((n: number, _c: any, at: number) =>
      n === 0
        ? obs(AvailabilityState.OUT_OF_STOCK, at, { signals: [{ kind: SignalKind.API_OUT_OF_STOCK, source: 'json' }] })
        : obs(AvailabilityState.AVAILABLE, at, {
            confidence: 0.95,
            signals: [{ kind: SignalKind.API_IN_STOCK, source: 'json' }],
          }),
    );
    engine.setTargets([target], false);
    target.nextDueAt = clock.now();

    await engine.tick(); // OOS baseline
    // advance beyond spacing + interval
    await clock.advance(20_000);
    target.nextDueAt = clock.now();
    await engine.tick(); // AVAILABLE

    expect(dispatcher.alerts.length).toBe(1);
    expect(dispatcher.alerts[0]!.state).toBe(AvailabilityState.AVAILABLE);
    expect(adapter.checks).toBe(2);
  });

  it('low-confidence restock is confirmed before alerting (two checks, one alert)', async () => {
    const { engine, target, clock, dispatcher } = setup((n: number, _c: any, at: number) =>
      n === 0
        ? obs(AvailabilityState.OUT_OF_STOCK, at)
        : obs(AvailabilityState.AVAILABLE, at, {
            confidence: 0.6,
            signals: [{ kind: SignalKind.BUY_CONTROL_PRESENT, source: 'dom' }],
          }),
    );
    engine.setTargets([target], false);
    target.nextDueAt = clock.now();

    await engine.tick(); // OOS
    await clock.advance(20_000);
    target.nextDueAt = clock.now();
    await engine.tick(); // AVAILABLE (low conf) -> needs confirmation, no alert yet
    expect(dispatcher.alerts.length).toBe(0);
    expect(target.pendingAvailableConfirms).toBe(1);

    // confirmation is scheduled ~30s out
    await clock.advance(31_000);
    await engine.tick(); // confirming re-check reproduces AVAILABLE -> alert
    expect(dispatcher.alerts.length).toBe(1);
  });

  it('AVAILABLE flap (gone on confirm) produces NO alert', async () => {
    const seq = [
      obs(AvailabilityState.OUT_OF_STOCK, 0),
      obs(AvailabilityState.AVAILABLE, 0, { confidence: 0.6, signals: [{ kind: SignalKind.BUY_CONTROL_PRESENT, source: 'dom' }] }),
      obs(AvailabilityState.OUT_OF_STOCK, 0), // confirmation contradicts
    ];
    let i = 0;
    const { engine, target, clock, dispatcher } = setup((_n: number, _c: any, at: number) => {
      const o = seq[Math.min(i, seq.length - 1)]!;
      i++;
      return { ...o, at };
    });
    engine.setTargets([target], false);
    target.nextDueAt = clock.now();
    await engine.tick();
    await clock.advance(20_000);
    target.nextDueAt = clock.now();
    await engine.tick(); // available low-conf -> confirm
    await clock.advance(31_000);
    await engine.tick(); // confirm -> OOS
    expect(dispatcher.alerts.length).toBe(0);
    expect(target.lastCommercialState).toBe(AvailabilityState.OUT_OF_STOCK);
  });

  it('Swiggy-style empty/WAF-stub is UNKNOWN, never an OOS or AVAILABLE alert', async () => {
    const { engine, target, clock, dispatcher } = setup((_n: number, _c: any, at: number) =>
      obs(AvailabilityState.UNKNOWN, at, { confidence: 0, signals: [{ kind: SignalKind.AMBIGUOUS_EMPTY, source: 'waf' }] }),
    );
    engine.setTargets([target], false);
    target.nextDueAt = clock.now();
    await engine.tick();
    expect(dispatcher.alerts.length).toBe(0);
    expect(target.state).toBe(AvailabilityState.UNKNOWN);
  });
});

describe('engine — dedup across restart', () => {
  it('does not re-alert an edge already dispatched before a restart', async () => {
    // First run: produce a restock alert.
    const first = setup((n: number, _c: any, at: number) =>
      n === 0
        ? obs(AvailabilityState.OUT_OF_STOCK, at)
        : obs(AvailabilityState.AVAILABLE, at, { confidence: 0.95, signals: [{ kind: SignalKind.API_IN_STOCK, source: 'json' }] }),
    );
    first.engine.setTargets([first.target], false);
    first.target.nextDueAt = first.clock.now();
    await first.engine.tick();
    await first.clock.advance(20_000);
    first.target.nextDueAt = first.clock.now();
    await first.engine.tick();
    expect(first.dispatcher.alerts.length).toBe(1);
    const dedupKeys = first.storage.loadDedupKeys();
    expect(dedupKeys.length).toBe(1);

    // "Restart": new engine seeded with persisted dedup keys, target already
    // AVAILABLE at the same stateSince, sees AVAILABLE again -> no new alert.
    const restart = setup(
      (_n: number, _c: any, at: number) =>
        obs(AvailabilityState.AVAILABLE, at, { confidence: 0.95, signals: [{ kind: SignalKind.API_IN_STOCK, source: 'json' }] }),
      { seedDedup: dedupKeys },
    );
    // carry over the target's machine state (as persistence would)
    const carried = { ...first.target };
    restart.engine.setTargets([carried], false);
    carried.nextDueAt = restart.clock.now();
    await restart.engine.tick();
    expect(restart.dispatcher.alerts.length).toBe(0);
  });
});

describe('engine — offline handling', () => {
  it('goes offline without ERROR spam and resumes on reconnect', async () => {
    const { engine, target, clock, net, notices, storage, adapter } = setup((_n: number, _c: any, at: number) =>
      obs(AvailabilityState.OUT_OF_STOCK, at),
    );
    engine.setTargets([target], false);
    target.nextDueAt = clock.now();

    net.online = false;
    const checks = await engine.tick();
    expect(checks).toBe(0);
    expect(engine.isOffline()).toBe(true);
    expect(adapter.checks).toBe(0);
    // No ERROR observations were recorded while offline
    expect(storage.observations.length).toBe(0);
    expect(notices.filter((n) => n.kind === 'offline').length).toBe(1);

    net.online = true;
    await engine.tick();
    expect(engine.isOffline()).toBe(false);
    expect(notices.filter((n) => n.kind === 'online').length).toBe(1);
  });
});

describe('engine — bulkhead isolation', () => {
  it('a throwing adapter yields ERROR for its target but never throws out of tick', async () => {
    const { engine, target, clock, storage } = setup(() => {
      throw new Error('adapter blew up');
    });
    engine.setTargets([target], false);
    target.nextDueAt = clock.now();
    await expect(engine.tick()).resolves.toBeGreaterThanOrEqual(0);
    const last = storage.observations.at(-1);
    expect(last?.obs.state).toBe(AvailabilityState.ERROR);
  });
});

describe('engine — keyword resolution', () => {
  it('resolves a keyword product via search once, then monitors the resolved ref', async () => {
    const product = makeProduct({ id: 'kw', mode: 'keyword', keywords: ['iphone 17 pro max'], urls: undefined });
    const { engine, target, clock, adapter, storage } = setup(
      (_n: number, _c: any, at: number) => obs(AvailabilityState.OUT_OF_STOCK, at),
      { product },
    );
    adapter.candidates = [
      { title: 'iPhone 17 Pro Max 256GB', url: 'https://blinkit.com/prn/x/prid/999', platformRef: '999' },
    ];
    engine.setTargets([target], false);
    target.nextDueAt = clock.now();
    await engine.tick();
    await clock.advance(20_000);
    target.nextDueAt = clock.now();
    await engine.tick();
    // searched once (cached afterward)
    expect(adapter.searches).toBe(1);
    expect(storage.resolutions.get('t1')?.platformRef).toBe('999');
  });
});
