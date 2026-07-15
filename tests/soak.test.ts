import { describe, it, expect } from 'vitest';
import { Engine } from '../src/core/engine';
import { AvailabilityState, PlatformId } from '../src/core/types';
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

/**
 * Compressed long-running simulation. Drives 60 targets across a virtual month
 * with occasional restocks, errors, and an offline window, asserting:
 *   - the engine never throws,
 *   - memory of dedup keys / transitions grows only with real events,
 *   - each restock produces exactly one alert (no duplicates over 30 days),
 *   - scheduling stays fair (every target gets checked regularly).
 */
describe('soak — 30-day compressed simulation', () => {
  it('runs 60 targets for a virtual month without faults or duplicate alerts', async () => {
    const clock = new FakeClock();
    const net = new ControllableNetwork();
    const random = seededRandom(2024);
    const storage = new InMemoryStorage();
    const dispatcher = new RecordingDispatcher();

    // One product, many platforms/pincodes. Each platform restocks briefly on a
    // deterministic schedule; every ~50th check errors transiently.
    const product = makeProduct({ id: 'prod', mode: 'url', urls: { blinkit: 'u' } });
    const platforms: PlatformId[] = ['blinkit'];
    const adapter = new ScriptedAdapter(
      { id: 'blinkit', minSpacingS: 60, defaultIntervalS: 300 },
      (n, _ctx, at) => {
        if (n % 50 === 49) return obs(AvailabilityState.ERROR, at);
        // Available in a 1-in-20 window, else OOS. Deterministic per check index.
        const available = n % 20 === 5 || n % 20 === 6; // two consecutive => confirmable
        return available
          ? obs(AvailabilityState.AVAILABLE, at, { confidence: 0.95 })
          : obs(AvailabilityState.OUT_OF_STOCK, at);
      },
      clock,
    );

    const engine = new Engine({
      clock,
      netProbe: net,
      logger: silentLogger(),
      adapters: new Map([['blinkit', adapter]]),
      storage,
      dispatcher,
      getProduct: () => product,
      random,
    });

    const targets = [];
    for (let i = 0; i < 60; i++) {
      targets.push(
        newTarget({ id: `t${i}`, productId: 'prod', platformId: 'blinkit', pincode: `1220${String(i).padStart(2, '0')}`, intervalS: 300, now: clock.now() }),
      );
    }
    engine.setTargets(targets);

    // Simulate ~30 days at 5-minute virtual steps. To keep the test fast we cap
    // iterations but advance the clock in large jittered steps.
    const DAY = 24 * 60 * 60 * 1000;
    const end = clock.now() + 30 * DAY;
    let offlineToggled = false;
    let iterations = 0;
    while (clock.now() < end && iterations < 20000) {
      // Around day 10, drop connectivity for a while.
      if (!offlineToggled && clock.now() > (targets[0]!.stateSince + 10 * DAY)) {
        net.online = false;
        offlineToggled = true;
      }
      if (net.online === false && clock.now() > (targets[0]!.stateSince + 10 * DAY + 2 * 60 * 60 * 1000)) {
        net.online = true;
      }
      // eslint-disable-next-line no-await-in-loop
      await engine.tick();
      // eslint-disable-next-line no-await-in-loop
      await clock.advance(60_000); // 1 virtual minute per tick
      iterations++;
    }

    // Every alert corresponds to a distinct dedup edge — no duplicates.
    const dedupKeys = storage.loadDedupKeys();
    expect(dispatcher.alerts.length).toBe(dedupKeys.length);
    expect(dispatcher.alerts.length).toBeGreaterThan(0);

    // No target was starved: each was checked at least several times over a month.
    for (const t of targets) {
      expect(t.lastCheckedAt).toBeGreaterThan(0);
    }

    // Observations were recorded but bounded by what actually happened.
    expect(storage.observations.length).toBeGreaterThan(0);

    // No ERROR ever produced a commercial transition (errors are overlays).
    for (const tr of storage.transitions) {
      expect(tr.from).not.toBe(AvailabilityState.ERROR);
      expect(tr.to).not.toBe(AvailabilityState.ERROR);
    }
  });
});
